import {
  ClientMessageType,
  ParticipationLabel,
  RoundStatus,
  ServerMessageType,
  SessionStatus,
  SwapState,
  WebhookEventType
} from '../shared/protocol.js';
import config from '../config.js';
import redisStore from '../store/redisStore.js';
import { buildBoxes } from '../domain/prizes.js';
import { closeSwaps, requestSwap } from '../domain/swaps.js';
import { createRound, createRoundPlayers, findPlayer } from '../domain/sessionState.js';
import {
  MINIMUM_PLAYERS_TO_START,
  buildPlayerConnectionPayload,
  buildPlayerJoinedPayload,
  buildRoundCancelledPayload,
  buildRoundEndedPayload,
  buildRoundJoinWindowStartedPayload,
  buildRoundStartedPayload,
  buildRoundSwapMatchedPayload,
  buildSessionEndedPayload,
  buildSessionReplayStartedPayload,
  buildSessionReplayWaitingPayload
} from '../webhooks/payloads.js';
import { dispatchWebhook } from '../webhooks/dispatcher.js';
import { notifyMatchmakingSessionClosed } from '../webhooks/matchmakingNotifier.js';
import { send, sendError } from '../ws/wsProtocol.js';

const CONTAINER_SIZE = 12;
const MAX_PLAYER_NAME_LENGTH = 15;
const PRE_ROUND_LIFETIME_END_REASON = 'session_max_lifetime_exceeded';

function normalizePlayerName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_PLAYER_NAME_LENGTH);
}

function buildInitials(name) {
  const letters = normalizePlayerName(name)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
  return letters || 'PL';
}

function formatCurrency(amount) {
  const numeric = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `N${numeric.toLocaleString('en-US')}`;
}

function getSwapActionCloseOffsetMs({ swapPhaseMs, softLockPercent }) {
  const safePhaseMs = Math.max(1, Number(swapPhaseMs || 0));
  const safePercent = Math.min(100, Math.max(0, Number(softLockPercent || 0)));
  return Math.max(0, safePhaseMs - Math.floor((safePhaseMs * safePercent) / 100));
}

export class SessionRuntime {
  constructor(session) {
    this.session = session;
    this.round = null;
    this.players = [];
    this.boxes = [];
    this.swaps = { queue: [], matched: [], keepers: [] };
    this.connections = new Map();
    this.timers = {
      preRoundLifetime: null,
      joinDeadline: null,
      readyCheck: null,
      distribution: null,
      swapSoftLock: null,
      swapClose: null,
      resultsRelease: null,
      replayEnd: null
    };
  }

  clearTimer(name) {
    if (!this.timers[name]) return;
    clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  clearAllTimers() {
    for (const name of Object.keys(this.timers)) {
      this.clearTimer(name);
    }
  }

  getLastRoundStatus() {
    switch (this.round?.status) {
      case RoundStatus.ROUND_CANCELLED:
        return 'cancelled';
      case RoundStatus.ROUND_ENDED:
        return 'ended';
      default:
        return null;
    }
  }

  isRoundPreStart(status = this.round?.status) {
    return [
      RoundStatus.WAITING_FOR_FIRST_JOIN,
      RoundStatus.JOIN_WINDOW_OPEN,
      RoundStatus.READY_CHECK
    ].includes(status);
  }

  isRoundStarted(status = this.round?.status) {
    return [
      RoundStatus.DISTRIBUTING,
      RoundStatus.SWAP_OPEN,
      RoundStatus.SWAP_CLOSED,
      RoundStatus.ROUND_ENDED
    ].includes(status);
  }

  isRoundOngoing(status = this.round?.status) {
    return [
      RoundStatus.DISTRIBUTING,
      RoundStatus.SWAP_OPEN,
      RoundStatus.SWAP_CLOSED
    ].includes(status);
  }

  shouldApplyPreRoundLifetime() {
    return (
      config.sessionInactivityTimeoutMs > 0
      && Number(this.session?.roundCount || 0) <= 1
      && this.isRoundPreStart()
    );
  }

  schedulePreRoundLifetime() {
    this.clearTimer('preRoundLifetime');
    if (!this.shouldApplyPreRoundLifetime()) {
      return;
    }

    const createdAt = Number(this.session?.createdAt || 0);
    const deadlineAt = createdAt + config.sessionInactivityTimeoutMs;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    this.timers.preRoundLifetime = setTimeout(() => {
      this.handlePreRoundLifetimeExpiry().catch((error) => console.error(error));
    }, remainingMs);
    this.timers.preRoundLifetime.unref?.();
  }

  async initializeNewRound(round, players) {
    this.clearAllTimers();
    this.round = round;
    this.players = players;
    this.boxes = [];
    this.swaps = { queue: [], matched: [], keepers: [] };
    this.session.currentRoundId = round.roundId;
    await redisStore.setReplayState(this.session.sessionId, null);
    await this.persistVisibleState();
    this.schedulePreRoundLifetime();
  }

  attachConnection(playerId, ws) {
    this.connections.set(playerId, ws);
    ws.playerId = playerId;
    ws.sessionId = this.session.sessionId;
  }

  detachConnection(playerId) {
    this.connections.delete(playerId);
  }

  getJoinedCount() {
    return this.players.filter((player) => player.hasJoinedRound).length;
  }

  getCurrentBoxNumber(playerId) {
    const box = this.boxes.find((entry) => entry.currentOwnerPlayerId === playerId);
    return box?.boxNumber || null;
  }

  async releasePlayerLocks(playerIds = []) {
    const uniquePlayerIds = [...new Set((playerIds || []).filter(Boolean))];
    await Promise.allSettled(
      uniquePlayerIds.map((playerId) =>
        redisStore.releasePlayerActiveSession(playerId, this.session.sessionId)
      )
    );
  }

  async persist() {
    await redisStore.setSession(this.session);
    await redisStore.setRound(this.round);
    await redisStore.setPlayers(this.session.sessionId, this.players);
    await redisStore.setBoxes(this.session.sessionId, this.round.roundId, this.boxes);
    await redisStore.setSwaps(this.session.sessionId, this.round.roundId, this.swaps);
  }

  async appendEvent(type, payload = {}) {
    await redisStore.pushEvent(this.session.sessionId, {
      type,
      sessionId: this.session.sessionId,
      roundId: this.round?.roundId || null,
      roundNumber: this.round?.roundNumber || null,
      timestamp: Date.now(),
      payload
    });
  }

  broadcast(type, payload = {}, targetPlayerId = null) {
    for (const [playerId, ws] of this.connections.entries()) {
      if (targetPlayerId && playerId !== targetPlayerId) continue;
      send(ws, type, payload);
    }
  }

  sendToPlayer(playerId, type, payload = {}) {
    const ws = this.connections.get(playerId);
    if (!ws) return;
    send(ws, type, payload);
  }

  bumpSnapshotRevision() {
    this.session.snapshotRevision = (this.session.snapshotRevision || 0) + 1;
  }

  async persistVisibleState() {
    this.bumpSnapshotRevision();
    await this.persist();
  }

  async finalizeSessionClosure({ lastRoundStatus = null } = {}) {
    const payload = buildSessionEndedPayload({
      eventName: WebhookEventType.SESSION_ENDED,
      session: this.session,
      round: this.round,
      lastRoundStatus
    });
    await dispatchWebhook(WebhookEventType.SESSION_ENDED, payload);
    await notifyMatchmakingSessionClosed(payload);
    this.broadcast(ServerMessageType.ERROR, {
      code: 'SESSION_ENDED',
      message: this.session.endReason || 'session_ended'
    });
    await this.releasePlayerLocks(this.session.registeredPlayerIds);
    await redisStore.removeActiveSession(this.session.sessionId);
    return payload;
  }

  async cancelPreRoundSession(reason, options = {}) {
    const {
      minimumPlayersRequired = MINIMUM_PLAYERS_TO_START,
      emitRoundCancelled = true,
      eventPayload = {}
    } = options;

    this.clearAllTimers();
    if (this.round) {
      this.round.status = RoundStatus.ROUND_CANCELLED;
      this.round.roundEndReason = reason;
      this.round.endedAt = Date.now();
    }
    this.session.status = SessionStatus.CANCELLED;
    this.session.endedAt = Date.now();
    this.session.endReason = reason;
    await this.persistVisibleState();

    if (emitRoundCancelled) {
      await this.appendEvent('round.cancelled', eventPayload);
      await dispatchWebhook(
        WebhookEventType.ROUND_CANCELLED,
        buildRoundCancelledPayload({
          eventName: WebhookEventType.ROUND_CANCELLED,
          session: this.session,
          round: this.round,
          players: this.players,
          minimumPlayersRequired
        })
      );
    }

    await this.finalizeSessionClosure({ lastRoundStatus: 'cancelled' });
    return {
      ok: true,
      sessionId: this.session.sessionId,
      sessionStatus: this.session.status,
      roundStatus: this.round?.status || null
    };
  }

  async handlePreRoundLifetimeExpiry() {
    if (!this.shouldApplyPreRoundLifetime()) {
      return;
    }

    await this.cancelPreRoundSession(PRE_ROUND_LIFETIME_END_REASON, {
      eventPayload: {
        reason: PRE_ROUND_LIFETIME_END_REASON,
        joinedCount: this.getJoinedCount()
      }
    });
  }

  async requestSessionEnd(reason = 'manual_end') {
    if (this.isRoundOngoing()) {
      return {
        ok: false,
        error: 'ROUND_ONGOING',
        sessionStatus: this.session.status,
        roundStatus: this.round?.status || null
      };
    }

    if (this.round?.status === RoundStatus.ROUND_CANCELLED) {
      await this.endSession(reason, { lastRoundStatus: 'cancelled' });
      return {
        ok: true,
        sessionId: this.session.sessionId,
        sessionStatus: this.session.status,
        roundStatus: this.round?.status || null
      };
    }

    if (this.round?.status === RoundStatus.ROUND_ENDED) {
      await this.endSession(reason, { lastRoundStatus: 'ended' });
      return {
        ok: true,
        sessionId: this.session.sessionId,
        sessionStatus: this.session.status,
        roundStatus: this.round?.status || null
      };
    }

    if (this.isRoundPreStart()) {
      return this.cancelPreRoundSession(reason, {
        eventPayload: {
          reason,
          joinedCount: this.getJoinedCount()
        }
      });
    }

    await this.endSession(reason, { lastRoundStatus: this.getLastRoundStatus() });
    return {
      ok: true,
      sessionId: this.session.sessionId,
      sessionStatus: this.session.status,
      roundStatus: this.round?.status || null
    };
  }

  buildWelcome(player) {
    return {
      sessionId: this.session.sessionId,
      playerId: player.playerId,
      playerName: player.playerName || null,
      sessionState: this.session.status,
      expectedPlayerCount: this.round?.expectedPlayerCountForRound || this.session.currentExpectedPlayerCount,
      readyTimeoutMs: config.readyCheckTimeoutMs
    };
  }

  buildReadyStatus() {
    return {
      joinedCount: this.getJoinedCount(),
      readyCount: this.round?.readyPlayerIdsForRound?.length || 0,
      expectedPlayerCount: this.round?.expectedPlayerCountForRound || this.session.currentExpectedPlayerCount,
      readyEndsAt: this.round?.readyCheckDeadlineAt || null,
      readyPlayerIds: [...(this.round?.readyPlayerIdsForRound || [])]
    };
  }

  buildSessionInitFor(player) {
    return {
      sessionId: this.session.sessionId,
      roundId: this.round.roundId,
      playerBox: player.initialBoxNumber,
      partnerBox: null,
      totalPlayers: this.round.expectedPlayerCountForRound,
      containerSize: CONTAINER_SIZE,
      swapWindowSeconds: Math.max(1, Math.round(config.swapPhaseMs / 1000)),
      softLockPercent: config.swapSoftLockPercent,
      softLockAt: this.round.swapActionClosesAt,
      swapEndsAt: this.round.swapEndsAt,
      playerName: player.playerName || null,
      playerInitials: buildInitials(player.playerName),
      stakeAmount: formatCurrency(this.session.stakeAmount),
      rewardPool: Number(this.round.rewardPool || 0)
    };
  }

  buildLeaderboardData(requestingPlayerId) {
    return {
      players: this.players.map((player) => ({
        name: player.playerName || player.playerId,
        init: buildInitials(player.playerName || player.playerId),
        origBox: player.initialBoxNumber,
        curBox: player.finalBoxNumber ?? player.initialBoxNumber,
        prize: Number(player.finalPrizeAmount || 0),
        win: !!player.isWinner,
        swapped: player.initialBoxId != null && player.finalBoxId != null && player.initialBoxId !== player.finalBoxId,
        you: player.playerId === requestingPlayerId,
        playerId: player.playerId
      })),
      rewardPool: Number(this.round.rewardPool || 0),
      totalPlayers: this.round.expectedPlayerCountForRound
    };
  }

  buildRoundResult(player) {
    return {
      result: player.isWinner ? 'win' : 'lose',
      prize: Number(player.finalPrizeAmount || 0),
      finalBox: player.finalBoxNumber,
      didSwap: player.initialBoxId != null && player.finalBoxId != null && player.initialBoxId !== player.finalBoxId
    };
  }

  emitReadyStatus(targetPlayerId = null) {
    this.broadcast(ServerMessageType.READY_STATUS, this.buildReadyStatus(), targetPlayerId);
  }

  removePendingSwap(playerId) {
    this.swaps.queue = this.swaps.queue.filter((entry) => entry.playerId !== playerId);
  }

  isSoftLockActive(now = Date.now()) {
    return Number.isFinite(this.round?.swapActionClosesAt) && now >= Number(this.round.swapActionClosesAt);
  }

  sendRuntimeStateToPlayer(player) {
    if (!player) return;

    if ([RoundStatus.DISTRIBUTING, RoundStatus.SWAP_OPEN, RoundStatus.SWAP_CLOSED, RoundStatus.ROUND_ENDED].includes(this.round.status)) {
      this.sendToPlayer(player.playerId, ServerMessageType.SESSION_INIT, this.buildSessionInitFor(player));
    }

    if (player.swapState === SwapState.MATCHED) {
      this.sendToPlayer(player.playerId, ServerMessageType.SWAP_RESULT, {
        outcome: 'found',
        partnerBox: player.finalBoxNumber ?? this.getCurrentBoxNumber(player.playerId)
      });
    } else if (player.swapState === SwapState.UNMATCHED) {
      this.sendToPlayer(player.playerId, ServerMessageType.SWAP_RESULT, { outcome: 'not_found' });
    } else if (player.swapState === SwapState.KEPT && player.softLockSource && player.softLockSource !== 'MANUAL_KEEP') {
      this.sendToPlayer(player.playerId, ServerMessageType.SOFTLOCK, {
        finalBox: this.getCurrentBoxNumber(player.playerId),
        priorSwapState: player.softLockSource
      });
    } else if (player.swapState === SwapState.PENDING && this.isSoftLockActive()) {
      this.sendToPlayer(player.playerId, ServerMessageType.SOFTLOCK, {
        finalBox: this.getCurrentBoxNumber(player.playerId),
        priorSwapState: 'PENDING'
      });
    }

    if (this.round.status === RoundStatus.ROUND_ENDED && player.finalBoxNumber != null) {
      this.sendToPlayer(player.playerId, ServerMessageType.ROUND_RESULT, this.buildRoundResult(player));
    }
  }

  async markJoinIntent({ playerId, playerName }) {
    const player = findPlayer(this.players, playerId);
    if (!player) return { ok: false, error: 'PLAYER_NOT_REGISTERED' };
    if ([SessionStatus.ENDED, SessionStatus.CANCELLED].includes(this.session.status)) {
      return { ok: false, error: 'SESSION_ENDED' };
    }

    player.playerName = normalizePlayerName(playerName) || player.playerName || playerId;
    player.lastSeenAt = Date.now();

    const lateJoinPhase = [
      RoundStatus.DISTRIBUTING,
      RoundStatus.SWAP_OPEN,
      RoundStatus.SWAP_CLOSED,
      RoundStatus.ROUND_ENDED,
      RoundStatus.ROUND_CANCELLED
    ].includes(this.round.status);

    if (lateJoinPhase) {
      await this.persistVisibleState();
      return {
        ok: true,
        sessionId: this.session.sessionId,
        roundId: this.round.roundId,
        joinDeadlineAt: this.round.joinDeadlineAt,
        lateJoin: !player.hasJoinedRound
      };
    }

    const wasFirstJoinForRound = !this.round.firstJoinAt;
    if (!player.hasJoinedRound) {
      player.hasJoinedRound = true;
      player.joinedAt = Date.now();
      player.participationLabel = player.isConnected
        ? ParticipationLabel.JOINED_ACTIVE
        : ParticipationLabel.REGISTERED_ABSENT;
      this.round.joinedPlayerIdsForRound.push(playerId);
      await dispatchWebhook(
        WebhookEventType.PLAYER_JOINED,
        buildPlayerJoinedPayload({
          eventName: WebhookEventType.PLAYER_JOINED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: wasFirstJoinForRound ? 'first_join' : 'joined_current_round'
        })
      );
    }

    if (!this.round.firstJoinAt) {
      this.round.firstJoinAt = Date.now();
      this.round.joinDeadlineAt = config.devWaitForAllPlayers
        ? null
        : this.round.firstJoinAt + config.firstJoinTimeoutMs;
      this.round.status = RoundStatus.JOIN_WINDOW_OPEN;
      this.session.status = SessionStatus.ROUND_ACTIVE;
      await this.appendEvent('round.join_window_started', { playerId });
      await dispatchWebhook(
        WebhookEventType.ROUND_JOIN_WINDOW_STARTED,
        buildRoundJoinWindowStartedPayload({
          eventName: WebhookEventType.ROUND_JOIN_WINDOW_STARTED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: 'first_join'
        })
      );
      this.scheduleJoinDeadline();
    }

    await this.persistVisibleState();
    this.emitReadyStatus();

    if (this.getJoinedCount() === this.round.expectedPlayerCountForRound) {
      await this.enterReadyCheck('all_players_joined');
    }

    return {
      ok: true,
      sessionId: this.session.sessionId,
      roundId: this.round.roundId,
      joinDeadlineAt: this.round.joinDeadlineAt
    };
  }

  async handleHello(ws, message) {
    const playerId = String(message.playerId || message.playerID || '').trim();
    const player = findPlayer(this.players, playerId);
    if (!player) {
      sendError(ws, 'PLAYER_NOT_REGISTERED', 'Player is not registered for this session');
      return;
    }

    const wasDisconnected = player.participationLabel === ParticipationLabel.DISCONNECTED;
    player.playerName = normalizePlayerName(message.playerName) || player.playerName || player.playerId;
    player.isConnected = true;
    player.lastSeenAt = Date.now();
    player.participationLabel = player.hasJoinedRound
      ? ParticipationLabel.RECONNECTED
      : ParticipationLabel.REGISTERED_ABSENT;

    this.attachConnection(player.playerId, ws);
    send(ws, ServerMessageType.WELCOME, this.buildWelcome(player));
    this.emitReadyStatus(player.playerId);
    this.sendRuntimeStateToPlayer(player);
    await this.persistVisibleState();

    if (wasDisconnected) {
      await dispatchWebhook(
        WebhookEventType.PLAYER_RECONNECTED,
        buildPlayerConnectionPayload({
          eventName: WebhookEventType.PLAYER_RECONNECTED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: 'hello'
        })
      );
    }
  }

  scheduleJoinDeadline() {
    this.clearTimer('joinDeadline');
    if (config.devWaitForAllPlayers || !this.round.joinDeadlineAt) {
      return;
    }

    this.timers.joinDeadline = setTimeout(() => {
      this.handleJoinDeadline().catch((error) => console.error(error));
    }, Math.max(0, this.round.joinDeadlineAt - Date.now()));
  }

  async enterReadyCheck() {
    if (this.round.status !== RoundStatus.JOIN_WINDOW_OPEN) {
      return;
    }

    this.clearTimer('joinDeadline');
    this.clearTimer('readyCheck');
    this.round.status = RoundStatus.READY_CHECK;
    this.round.gatePlayerIdsForRound = [...this.round.registeredPlayerIdsForRound];
    this.round.readyPlayerIdsForRound = [];
    this.round.readyCheckStartedAt = Date.now();
    this.round.readyCheckDeadlineAt = this.round.readyCheckStartedAt + config.readyCheckTimeoutMs;

    for (const player of this.players) {
      player.isReadyForRound = false;
    }

    await this.persistVisibleState();
    this.emitReadyStatus();

    this.timers.readyCheck = setTimeout(() => {
      this.handleReadyCheckDeadline().catch((error) => console.error(error));
    }, Math.max(0, this.round.readyCheckDeadlineAt - Date.now()));
  }

  async handleRoundReady(playerId) {
    if (this.round.status !== RoundStatus.READY_CHECK) {
      return { ok: false, error: 'READY_CLOSED' };
    }

    if (!this.round.gatePlayerIdsForRound.includes(playerId)) {
      return { ok: false, error: 'PLAYER_NOT_ELIGIBLE_FOR_READY' };
    }

    const player = findPlayer(this.players, playerId);
    if (!player) {
      return { ok: false, error: 'PLAYER_NOT_REGISTERED' };
    }

    if (this.round.readyPlayerIdsForRound.includes(playerId)) {
      return { ok: true, alreadyReady: true };
    }

    player.isReadyForRound = true;
    player.lastSeenAt = Date.now();
    this.round.readyPlayerIdsForRound.push(playerId);
    await this.persistVisibleState();
    this.emitReadyStatus();

    if (this.round.readyPlayerIdsForRound.length >= this.round.gatePlayerIdsForRound.length) {
      await this.startRound('all_players_ready');
    }

    return { ok: true, alreadyReady: false };
  }

  async handleReadyCheckDeadline() {
    if (this.round.status !== RoundStatus.READY_CHECK) return;

    for (const player of this.players) {
      if (!this.round.gatePlayerIdsForRound.includes(player.playerId)) continue;
      if (this.round.readyPlayerIdsForRound.includes(player.playerId)) continue;
      player.isReadyForRound = true;
      this.round.readyPlayerIdsForRound.push(player.playerId);
    }

    await this.persistVisibleState();
    this.emitReadyStatus();
    await this.startRound('ready_timeout_elapsed');
  }

  async handleJoinDeadline() {
    if (config.devWaitForAllPlayers) return;

    const joinedCount = this.getJoinedCount();
    if (joinedCount < MINIMUM_PLAYERS_TO_START) {
      await this.cancelPreRoundSession('joined_below_minimum', {
        minimumPlayersRequired: MINIMUM_PLAYERS_TO_START,
        eventPayload: { joinedCount }
      });
      return;
    }

    await this.startRound('join_deadline_reached');
  }

  async startRound(reason) {
    if (![RoundStatus.JOIN_WINDOW_OPEN, RoundStatus.WAITING_FOR_FIRST_JOIN, RoundStatus.READY_CHECK].includes(this.round.status)) {
      return;
    }

    this.clearTimer('joinDeadline');
    this.clearTimer('readyCheck');
    this.clearTimer('preRoundLifetime');

    const allocation = buildBoxes({
      registeredPlayerIds: this.round.registeredPlayerIdsForRound,
      stakeAmount: this.session.stakeAmount,
      platformFeeType: this.session.platformFeeType,
      platformFeeValue: this.session.platformFeeValueSnapshot
    });

    this.round.grossStakeTotal = allocation.grossStakeTotal;
    this.round.feeAmount = allocation.feeAmount;
    this.round.rewardPool = allocation.rewardPool;
    this.round.winnerBase = allocation.winnerBase;
    this.round.winnerCount = allocation.winnerCount;
    this.round.auditSeed = allocation.auditSeed;
    this.boxes = allocation.boxes;

    for (const player of this.players) {
      const ownedBox = this.boxes.find((box) => box.initialOwnerPlayerId === player.playerId);
      player.connectedAtStartOfRound = player.isConnected;
      player.isReadyForRound = false;
      player.assignedBoxId = ownedBox?.boxId || null;
      player.currentBoxId = ownedBox?.boxId || null;
      player.initialBoxId = ownedBox?.boxId || null;
      player.initialBoxNumber = ownedBox?.boxNumber || null;
      player.finalBoxId = null;
      player.finalBoxNumber = null;
      player.finalPrizeAmount = null;
      player.isWinner = null;
      player.swapRequested = false;
      player.swapMatched = false;
      player.swapState = SwapState.NONE;
      player.softLockSource = null;
      player.result = null;
      player.participationLabel = player.hasJoinedRound
        ? ParticipationLabel.JOINED_ACTIVE
        : ParticipationLabel.REGISTERED_ABSENT;
    }

    this.round.status = RoundStatus.DISTRIBUTING;
    this.round.gatePlayerIdsForRound = [];
    this.round.readyCheckStartedAt = null;
    this.round.readyCheckDeadlineAt = null;
    this.round.readyPlayerIdsForRound = [];
    this.round.distributionStartedAt = Date.now();
    this.round.distributionDurationMs = config.distributionLeadMs;
    this.round.distributionEndsAt = this.round.distributionStartedAt + this.round.distributionDurationMs;
    this.round.distributionPackage = {
      phase: 'distribution',
      distributionStartedAt: this.round.distributionStartedAt,
      distributionEndsAt: this.round.distributionEndsAt,
      totalPlayers: this.round.expectedPlayerCountForRound,
      containerSize: CONTAINER_SIZE
    };
    this.round.swapStartedAt = this.round.distributionEndsAt;
    this.round.swapActionClosesAt = Math.min(
      this.round.swapStartedAt +
        getSwapActionCloseOffsetMs({
          swapPhaseMs: config.swapPhaseMs,
          softLockPercent: config.swapSoftLockPercent
        }),
      this.round.swapStartedAt + config.swapPhaseMs
    );
    this.round.swapEndsAt = this.round.swapStartedAt + config.swapPhaseMs;
    this.round.swapClosedAt = null;
    this.round.swapPackage = {
      phase: 'swap',
      swapStartedAt: this.round.swapStartedAt,
      swapActionClosesAt: this.round.swapActionClosesAt,
      swapEndsAt: this.round.swapEndsAt,
      softLockPercent: config.swapSoftLockPercent
    };
    this.round.revealAt = null;
    this.round.finalResultsReleaseAt = null;
    this.round.finalResultsSentAt = null;
    this.session.status = SessionStatus.ROUND_ACTIVE;
    await this.persistVisibleState();
    await this.appendEvent('round.started', { reason });
    await dispatchWebhook(
      WebhookEventType.ROUND_STARTED,
      buildRoundStartedPayload({
        eventName: WebhookEventType.ROUND_STARTED,
        session: this.session,
        round: this.round,
        players: this.players,
        boxes: this.boxes,
        reason
      })
    );

    for (const player of this.players) {
      this.sendToPlayer(player.playerId, ServerMessageType.SESSION_INIT, this.buildSessionInitFor(player));
    }

    this.timers.distribution = setTimeout(() => {
      this.openSwapWindow().catch((error) => console.error(error));
    }, Math.max(0, this.round.distributionEndsAt - Date.now()));
  }

  async openSwapWindow() {
    if (this.round.status !== RoundStatus.DISTRIBUTING) return;

    this.round.status = RoundStatus.SWAP_OPEN;
    await this.persistVisibleState();

    this.clearTimer('swapSoftLock');
    this.timers.swapSoftLock = setTimeout(() => {
      this.applySwapSoftLock().catch((error) => console.error(error));
    }, Math.max(0, this.round.swapActionClosesAt - Date.now()));

    this.clearTimer('swapClose');
    this.timers.swapClose = setTimeout(() => {
      this.closeSwapWindow().catch((error) => console.error(error));
    }, Math.max(0, this.round.swapEndsAt - Date.now()));
  }

  async handleSwapRequest(playerId) {
    if (this.round.status !== RoundStatus.SWAP_OPEN) {
      return { ok: false, error: 'SWAP_NOT_OPEN' };
    }

    const now = Date.now();
    if (this.round.swapEndsAt && now >= this.round.swapEndsAt) {
      return { ok: false, error: 'SWAP_NOT_OPEN' };
    }
    if (this.isSoftLockActive(now)) {
      return { ok: false, error: 'SOFTLOCK_ACTIVE' };
    }

    const result = requestSwap({
      players: this.players,
      boxes: this.boxes,
      swaps: this.swaps,
      playerId
    });
    if (!result.ok) return result;

    await this.persistVisibleState();
    if (result.pending) {
      return result;
    }

    await dispatchWebhook(
      WebhookEventType.ROUND_SWAP_MATCHED,
      buildRoundSwapMatchedPayload({
        eventName: WebhookEventType.ROUND_SWAP_MATCHED,
        session: this.session,
        round: this.round,
        players: this.players,
        boxes: this.boxes,
        matched: result.matched
      })
    );

    for (const swapPlayerId of [result.matched.firstPlayerId, result.matched.secondPlayerId]) {
      this.sendToPlayer(swapPlayerId, ServerMessageType.SWAP_RESULT, {
        outcome: 'found',
        partnerBox: this.getCurrentBoxNumber(swapPlayerId)
      });
    }

    return result;
  }

  async handleKeepBox(playerId) {
    const player = findPlayer(this.players, playerId);
    if (!player) return { ok: false, error: 'PLAYER_NOT_FOUND' };
    if (this.round.status !== RoundStatus.SWAP_OPEN) return { ok: false, error: 'SWAP_NOT_OPEN' };
    if (this.round.swapEndsAt && Date.now() >= this.round.swapEndsAt) return { ok: false, error: 'SWAP_NOT_OPEN' };
    if (this.isSoftLockActive()) return { ok: false, error: 'SOFTLOCK_ACTIVE' };

    if (player.swapState === SwapState.KEPT) {
      return { ok: false, error: 'BOX_ALREADY_KEPT' };
    }
    if (player.swapState !== SwapState.NONE) {
      return { ok: false, error: 'SWAP_ALREADY_USED' };
    }

    player.swapState = SwapState.KEPT;
    player.softLockSource = 'MANUAL_KEEP';
    this.swaps.keepers.push({
      playerId,
      keptAt: Date.now(),
      auto: false
    });
    this.removePendingSwap(playerId);
    await this.persistVisibleState();
    return { ok: true };
  }

  autoKeepRemainingPlayers() {
    const autoKeptPlayerIds = [];
    for (const player of this.players) {
      if (player.swapState !== SwapState.NONE) continue;
      player.swapState = SwapState.KEPT;
      player.softLockSource = 'NONE';
      this.swaps.keepers.push({
        playerId: player.playerId,
        keptAt: Date.now(),
        auto: true
      });
      autoKeptPlayerIds.push(player.playerId);
    }
    return autoKeptPlayerIds;
  }

  resolvePendingSwapsToUnmatched() {
    return closeSwaps({ players: this.players, swaps: this.swaps });
  }

  async applySwapSoftLock() {
    this.clearTimer('swapSoftLock');
    if (this.round.status !== RoundStatus.SWAP_OPEN) {
      return { unmatchedPlayerIds: [], autoKeptPlayerIds: [] };
    }

    const pendingPlayerIds = this.swaps.queue.map((entry) => entry.playerId);
    for (const playerId of pendingPlayerIds) {
      this.sendToPlayer(playerId, ServerMessageType.SOFTLOCK, {
        finalBox: this.getCurrentBoxNumber(playerId),
        priorSwapState: 'PENDING'
      });
    }

    const autoKeptPlayerIds = this.autoKeepRemainingPlayers();
    for (const playerId of autoKeptPlayerIds) {
      this.sendToPlayer(playerId, ServerMessageType.SOFTLOCK, {
        finalBox: this.getCurrentBoxNumber(playerId),
        priorSwapState: 'NONE'
      });
    }

    const unmatchedPlayerIds = this.resolvePendingSwapsToUnmatched();
    await this.persistVisibleState();

    for (const playerId of unmatchedPlayerIds) {
      this.sendToPlayer(playerId, ServerMessageType.SWAP_RESULT, {
        outcome: 'not_found'
      });
    }

    return { unmatchedPlayerIds, autoKeptPlayerIds };
  }

  finalizePlayerResults() {
    for (const player of this.players) {
      const finalBox = this.boxes.find((box) => box.currentOwnerPlayerId === player.playerId);
      player.finalBoxId = finalBox?.boxId || null;
      player.finalBoxNumber = finalBox?.boxNumber || null;
      player.finalPrizeAmount = finalBox?.rewardAmount ?? 0;
      player.isWinner = !!finalBox?.isWinningBox;
      player.participationLabel = ParticipationLabel.ROUND_COMPLETE;
      player.result = this.buildRoundResult(player);
    }
  }

  async publishResults() {
    if (this.round.status !== RoundStatus.SWAP_CLOSED) return;
    if (this.round.finalResultsSentAt) return;

    this.clearTimer('resultsRelease');
    this.finalizePlayerResults();

    this.round.finalResultsSentAt = Date.now();
    this.round.status = RoundStatus.ROUND_ENDED;
    this.round.endedAt = this.round.finalResultsSentAt;
    this.session.status = SessionStatus.REPLAY_WAITING;
    await this.persistVisibleState();

    for (const player of this.players) {
      this.sendToPlayer(player.playerId, ServerMessageType.ROUND_RESULT, player.result);
    }

    const roundEndedPayload = buildRoundEndedPayload({
      eventName: WebhookEventType.ROUND_ENDED,
      session: this.session,
      round: this.round,
      players: this.players,
      boxes: this.boxes,
      swaps: this.swaps
    });
    await dispatchWebhook(WebhookEventType.ROUND_ENDED, roundEndedPayload);
    await dispatchWebhook(
      WebhookEventType.SESSION_REPLAY_WAITING,
      buildSessionReplayWaitingPayload({
        eventName: WebhookEventType.SESSION_REPLAY_WAITING,
        session: this.session,
        round: this.round,
        players: this.players,
        replayWaitMs: config.replayWaitMs,
        replayBufferMs: config.replayBufferMs
      })
    );

    const replayWaitEndsAt = Date.now() + config.replayWaitMs + config.replayBufferMs;
    await redisStore.setReplayState(this.session.sessionId, {
      replayWaitEndsAt,
      roundId: this.round.roundId
    });

    this.timers.replayEnd = setTimeout(() => {
      this.endSession('replay_timeout').catch((error) => console.error(error));
    }, Math.max(0, replayWaitEndsAt - Date.now()));
  }

  async closeSwapWindow() {
    if (this.round.status !== RoundStatus.SWAP_OPEN) return;

    this.clearTimer('swapSoftLock');
    this.clearTimer('swapClose');

    if (!this.isSoftLockActive()) {
      this.autoKeepRemainingPlayers();
      this.resolvePendingSwapsToUnmatched().forEach((playerId) => {
        this.sendToPlayer(playerId, ServerMessageType.SWAP_RESULT, {
          outcome: 'not_found'
        });
      });
    }

    this.round.status = RoundStatus.SWAP_CLOSED;
    this.round.swapClosedAt = Date.now();
    this.round.finalResultsReleaseAt = this.round.swapClosedAt + config.calcDelayMs;
    await this.persistVisibleState();

    this.timers.resultsRelease = setTimeout(() => {
      this.publishResults().catch((error) => console.error(error));
    }, Math.max(0, this.round.finalResultsReleaseAt - Date.now()));
  }

  async handleSocketMessage(ws, message) {
    switch (message.type) {
      case ClientMessageType.PONG: {
        const player = findPlayer(this.players, ws.playerId);
        if (player) {
          player.lastSeenAt = Date.now();
          if (!player.isConnected) player.isConnected = true;
        }
        return;
      }
      case ClientMessageType.ROUND_READY: {
        const result = await this.handleRoundReady(ws.playerId);
        if (!result.ok) sendError(ws, result.error, 'Unable to mark player ready');
        return;
      }
      case ClientMessageType.SWAP_REQUEST: {
        const result = await this.handleSwapRequest(ws.playerId);
        if (!result.ok) sendError(ws, result.error, 'Unable to request swap');
        return;
      }
      case ClientMessageType.KEEP_BOX: {
        const result = await this.handleKeepBox(ws.playerId);
        if (!result.ok) sendError(ws, result.error, 'Unable to keep box');
        return;
      }
      case ClientMessageType.TIMER_END:
        return;
      case ClientMessageType.LEADERBOARD_REQUEST: {
        const player = findPlayer(this.players, ws.playerId);
        if (!player || player.finalBoxNumber == null) {
          sendError(ws, 'RESULTS_NOT_READY', 'Results are not ready yet.');
          return;
        }
        this.sendToPlayer(
          ws.playerId,
          ServerMessageType.LEADERBOARD_DATA,
          this.buildLeaderboardData(ws.playerId)
        );
        return;
      }
      default:
        sendError(ws, 'UNKNOWN_TYPE', `Unknown type ${message.type}`);
    }
  }

  async handleDisconnect(playerId, reason = 'socket_close') {
    const player = findPlayer(this.players, playerId);
    if (!player) return;
    if (!player.isConnected) return;

    player.isConnected = false;
    player.lastSeenAt = Date.now();
    player.participationLabel = ParticipationLabel.DISCONNECTED;
    this.detachConnection(playerId);
    await this.persistVisibleState();
    await dispatchWebhook(
      WebhookEventType.PLAYER_DISCONNECTED,
      buildPlayerConnectionPayload({
        eventName: WebhookEventType.PLAYER_DISCONNECTED,
        session: this.session,
        round: this.round,
        players: this.players,
        player,
        reason
      })
    );
  }

  async handleHeartbeatTimeouts(now) {
    for (const player of this.players) {
      if (!player.isConnected) continue;
      if (!player.lastSeenAt || now - player.lastSeenAt <= config.heartbeatTimeoutMs) continue;
      const ws = this.connections.get(player.playerId);
      ws?.terminate?.();
      await this.handleDisconnect(player.playerId, 'heartbeat_timeout');
    }
  }

  async createReplayRound(playerIds) {
    const previousPlayerIds = [...this.session.registeredPlayerIds];
    const removedPlayerIds = previousPlayerIds.filter((playerId) => !playerIds.includes(playerId));
    this.clearAllTimers();
    this.session.status = SessionStatus.WAITING_FOR_FIRST_JOIN;
    this.session.currentExpectedPlayerCount = playerIds.length;
    this.session.roundCount += 1;
    this.session.registeredPlayerIds = [...playerIds];

    const round = createRound({
      sessionId: this.session.sessionId,
      roundNumber: this.session.roundCount,
      playerIds
    });
    const players = createRoundPlayers(playerIds);
    await this.initializeNewRound(round, players);

    const now = Date.now();
    for (const [connectedPlayerId] of this.connections.entries()) {
      const replayPlayer = findPlayer(this.players, connectedPlayerId);
      if (!replayPlayer) {
        this.detachConnection(connectedPlayerId);
        continue;
      }
      replayPlayer.isConnected = true;
      replayPlayer.lastSeenAt = now;
      replayPlayer.participationLabel = ParticipationLabel.REGISTERED_ABSENT;
    }

    await this.persistVisibleState();
    for (const playerId of playerIds) {
      this.sendToPlayer(playerId, ServerMessageType.REPLAY_STARTED, {
        sessionId: this.session.sessionId,
        roundId: this.round.roundId,
        roundNumber: this.round.roundNumber,
        expectedPlayerCount: this.round.expectedPlayerCountForRound,
        readyTimeoutMs: config.readyCheckTimeoutMs
      });
    }
    this.emitReadyStatus();
    await dispatchWebhook(
      WebhookEventType.SESSION_REPLAY_STARTED,
      buildSessionReplayStartedPayload({
        eventName: WebhookEventType.SESSION_REPLAY_STARTED,
        session: this.session,
        round,
        players: this.players,
        replayPlayerIds: playerIds
      })
    );

    if (removedPlayerIds.length) {
      await this.releasePlayerLocks(removedPlayerIds);
    }
  }

  async resumeTimers(replayState = null) {
    if (!this.round) return;

    this.schedulePreRoundLifetime();

    if (this.round.status === RoundStatus.JOIN_WINDOW_OPEN && this.round.joinDeadlineAt) {
      this.scheduleJoinDeadline();
      return;
    }

    if (this.round.status === RoundStatus.READY_CHECK && this.round.readyCheckDeadlineAt) {
      this.clearTimer('readyCheck');
      if (Date.now() >= this.round.readyCheckDeadlineAt) {
        await this.handleReadyCheckDeadline();
      } else {
        this.timers.readyCheck = setTimeout(() => {
          this.handleReadyCheckDeadline().catch((error) => console.error(error));
        }, Math.max(0, this.round.readyCheckDeadlineAt - Date.now()));
      }
      return;
    }

    if (this.round.status === RoundStatus.DISTRIBUTING && this.round.distributionEndsAt) {
      this.clearTimer('distribution');
      this.timers.distribution = setTimeout(() => {
        this.openSwapWindow().catch((error) => console.error(error));
      }, Math.max(0, this.round.distributionEndsAt - Date.now()));
      return;
    }

    if (this.round.status === RoundStatus.SWAP_OPEN && this.round.swapEndsAt) {
      if (this.round.swapActionClosesAt) {
        this.clearTimer('swapSoftLock');
        if (Date.now() >= this.round.swapActionClosesAt) {
          await this.applySwapSoftLock();
        } else {
          this.timers.swapSoftLock = setTimeout(() => {
            this.applySwapSoftLock().catch((error) => console.error(error));
          }, Math.max(0, this.round.swapActionClosesAt - Date.now()));
        }
      }

      this.clearTimer('swapClose');
      this.timers.swapClose = setTimeout(() => {
        this.closeSwapWindow().catch((error) => console.error(error));
      }, Math.max(0, this.round.swapEndsAt - Date.now()));
      return;
    }

    if (this.round.status === RoundStatus.SWAP_CLOSED && this.round.finalResultsReleaseAt) {
      this.clearTimer('resultsRelease');
      if (Date.now() >= this.round.finalResultsReleaseAt) {
        await this.publishResults();
      } else {
        this.timers.resultsRelease = setTimeout(() => {
          this.publishResults().catch((error) => console.error(error));
        }, Math.max(0, this.round.finalResultsReleaseAt - Date.now()));
      }
      return;
    }

    if (this.session.status === SessionStatus.REPLAY_WAITING && replayState?.replayWaitEndsAt) {
      this.clearTimer('replayEnd');
      this.timers.replayEnd = setTimeout(() => {
        this.endSession('replay_timeout').catch((error) => console.error(error));
      }, Math.max(0, replayState.replayWaitEndsAt - Date.now()));
    }
  }

  async endSession(reason, options = {}) {
    this.clearAllTimers();
    this.session.status = SessionStatus.ENDED;
    this.session.endedAt = Date.now();
    this.session.endReason = reason;
    await this.persistVisibleState();
    await this.finalizeSessionClosure({
      lastRoundStatus: options.lastRoundStatus ?? this.getLastRoundStatus()
    });
  }
}
