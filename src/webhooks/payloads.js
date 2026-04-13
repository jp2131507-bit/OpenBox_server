import crypto from 'node:crypto';
import { calculateFee } from '../domain/fees.js';

export const WEBHOOK_EVENT_VERSION = 1;
export const MINIMUM_PLAYERS_TO_START = 2;

function roundStatusLabel(status) {
  switch (status) {
    case 'WAITING_FOR_FIRST_JOIN':
      return 'waitingForFirstJoin';
    case 'JOIN_WINDOW_OPEN':
      return 'joinWindowOpen';
    case 'DISTRIBUTING':
      return 'distributing';
    case 'SWAP_OPEN':
      return 'swapOpen';
    case 'SWAP_CLOSED':
      return 'swapClosed';
    case 'REVEALING':
      return 'revealing';
    case 'ROUND_ENDED':
      return 'ended';
    case 'ROUND_CANCELLED':
      return 'cancelled';
    default:
      return status ? String(status) : 'unknown';
  }
}

function sessionStatusLabel(status) {
  switch (status) {
    case 'WAITING_FOR_FIRST_JOIN':
      return 'waitingForFirstJoin';
    case 'ROUND_ACTIVE':
      return 'active';
    case 'REPLAY_WAITING':
      return 'replayWaiting';
    case 'ENDED':
      return 'ended';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return status ? String(status) : 'unknown';
  }
}

function lastRoundStatusLabel(status) {
  switch (status) {
    case 'ROUND_CANCELLED':
      return 'cancelled';
    case 'ROUND_ENDED':
      return 'ended';
    default:
      return null;
  }
}

function buildEnvelope(eventName, payload) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: WEBHOOK_EVENT_VERSION,
    occurredAt: Date.now(),
    sessionId: payload.sessionId || null,
    roundId: payload.roundId ?? null,
    roundNumber: payload.roundNumber ?? null,
    ...payload
  };
}

function getRegisteredPlayerCountForSession(session) {
  return Array.isArray(session?.registeredPlayerIds) ? session.registeredPlayerIds.length : 0;
}

function getExpectedPlayerCountForRound(session, round) {
  if (Number.isFinite(round?.expectedPlayerCountForRound)) {
    return round.expectedPlayerCountForRound;
  }
  return Number(session?.currentExpectedPlayerCount || session?.initialExpectedPlayerCount || 0);
}

function getJoinedPlayerCountForRound(round, players) {
  if (Array.isArray(round?.joinedPlayerIdsForRound)) {
    return round.joinedPlayerIdsForRound.length;
  }
  return (players || []).filter((player) => player.hasJoinedRound).length;
}

function getConnectedPlayerCountForRound(players) {
  return (players || []).filter((player) => player.isConnected).length;
}

function getConnectedPlayerCountAtRoundStart(players) {
  return (players || []).filter((player) => player.connectedAtStartOfRound).length;
}

function getTotalStakeAmount(session, round) {
  if (Number.isFinite(round?.grossStakeTotal)) {
    return round.grossStakeTotal;
  }

  const playerCount = getExpectedPlayerCountForRound(session, round);
  const stakeAmount = Number(session?.stakeAmount || 0);
  return Number((playerCount * stakeAmount).toFixed(2));
}

function getPlatformFeeAmount(session, round, totalStakeAmount) {
  if (Number.isFinite(round?.feeAmount)) {
    return round.feeAmount;
  }

  return calculateFee({
    grossStakeTotal: totalStakeAmount,
    platformFeeType: session?.platformFeeType,
    platformFeeValue: Number(session?.platformFeeValueSnapshot || 0)
  });
}

function buildPlatformFee(session, round) {
  const totalStakeAmount = getTotalStakeAmount(session, round);
  const feeAmount = getPlatformFeeAmount(session, round, totalStakeAmount);
  const effectivePercentage = totalStakeAmount > 0
    ? Number(((feeAmount / totalStakeAmount) * 100).toFixed(4))
    : 0;

  return {
    type: session?.platformFeeType || 'percentage',
    configuredValue: Number(session?.platformFeeValueSnapshot || 0),
    effectivePercentage,
    feeAmount
  };
}

function buildEconomy(session, round) {
  const totalStakeAmount = getTotalStakeAmount(session, round);
  const platformFee = buildPlatformFee(session, round);
  const rewardPool = Number.isFinite(round?.rewardPool)
    ? round.rewardPool
    : Number((totalStakeAmount - platformFee.feeAmount).toFixed(2));

  return {
    stakeAmount: Number(session?.stakeAmount || 0),
    totalStakeAmount,
    platformFee,
    rewardPool
  };
}

function buildPlayerBase(player) {
  return {
    playerId: player?.playerId || null,
    playerName: player?.playerName || null,
    hasJoinedRound: !!player?.hasJoinedRound,
    isConnected: !!player?.isConnected,
    participationLabel: player?.participationLabel || null,
    joinedAt: player?.joinedAt ?? null,
    lastSeenAt: player?.lastSeenAt ?? null
  };
}

function buildPlayerMinimal(player) {
  return buildPlayerBase(player);
}

function buildPlayerRoundState(player) {
  return {
    ...buildPlayerBase(player),
    connectedAtStartOfRound: !!player?.connectedAtStartOfRound,
    initialBoxId: player?.initialBoxId ?? null,
    initialBoxNumber: player?.initialBoxNumber ?? null
  };
}

function buildBoxState(box) {
  return {
    boxId: box?.boxId || null,
    boxNumber: box?.boxNumber ?? null,
    rewardAmount: box?.rewardAmount ?? 0,
    isWinningBox: !!box?.isWinningBox,
    initialOwnerPlayerId: box?.initialOwnerPlayerId || null,
    currentOwnerPlayerId: box?.currentOwnerPlayerId || null
  };
}

function indexPlayersById(players) {
  return new Map((players || []).map((player) => [player.playerId, player]));
}

function indexBoxesById(boxes) {
  return new Map((boxes || []).map((box) => [box.boxId, box]));
}

function buildSwapMatchSummaries(swaps, players, boxes) {
  const playersById = indexPlayersById(players);
  const boxesById = indexBoxesById(boxes);

  return (swaps?.matched || []).map((match) => {
    const firstPlayer = playersById.get(match.firstPlayerId) || null;
    const secondPlayer = playersById.get(match.secondPlayerId) || null;
    const firstBoxBefore = boxesById.get(match.firstBoxId) || null;
    const secondBoxBefore = boxesById.get(match.secondBoxId) || null;

    return {
      matchedAt: match.matchedAt ?? null,
      firstPlayer: firstPlayer
        ? { playerId: firstPlayer.playerId, playerName: firstPlayer.playerName || null }
        : { playerId: match.firstPlayerId || null, playerName: null },
      secondPlayer: secondPlayer
        ? { playerId: secondPlayer.playerId, playerName: secondPlayer.playerName || null }
        : { playerId: match.secondPlayerId || null, playerName: null },
      firstBoxBefore: firstBoxBefore ? buildBoxState(firstBoxBefore) : null,
      secondBoxBefore: secondBoxBefore ? buildBoxState(secondBoxBefore) : null,
      firstBoxAfter: secondBoxBefore ? buildBoxState(secondBoxBefore) : null,
      secondBoxAfter: firstBoxBefore ? buildBoxState(firstBoxBefore) : null,
      swapMatch: {
        matchedAt: match.matchedAt ?? null,
        firstPlayerId: match.firstPlayerId || null,
        secondPlayerId: match.secondPlayerId || null,
        firstBoxId: match.firstBoxId || null,
        secondBoxId: match.secondBoxId || null
      }
    };
  });
}

function buildSwapLookup(swaps) {
  const map = new Map();

  for (const match of swaps?.matched || []) {
    map.set(match.firstPlayerId, {
      swapMatchedWithPlayerId: match.secondPlayerId,
      swapMatchedAt: match.matchedAt ?? null
    });
    map.set(match.secondPlayerId, {
      swapMatchedWithPlayerId: match.firstPlayerId,
      swapMatchedAt: match.matchedAt ?? null
    });
  }

  return map;
}

function buildRoundSettlementPlayers(players, swaps) {
  const swapLookup = buildSwapLookup(swaps);

  return (players || []).map((player) => {
    const swapMeta = swapLookup.get(player.playerId) || {
      swapMatchedWithPlayerId: null,
      swapMatchedAt: null
    };

    return {
      ...buildPlayerBase(player),
      connectedAtStartOfRound: !!player.connectedAtStartOfRound,
      initialBoxId: player.initialBoxId ?? null,
      initialBoxNumber: player.initialBoxNumber ?? null,
      finalBoxId: player.finalBoxId ?? null,
      finalBoxNumber: player.finalBoxNumber ?? null,
      finalPrizeAmount: player.finalPrizeAmount ?? 0,
      isWinner: !!player.isWinner,
      swapped: player.initialBoxId != null && player.finalBoxId != null && player.initialBoxId !== player.finalBoxId,
      swapRequested: !!player.swapRequested,
      swapMatched: !!player.swapMatched,
      swapMatchedWithPlayerId: swapMeta.swapMatchedWithPlayerId,
      swapMatchedAt: swapMeta.swapMatchedAt
    };
  });
}

function buildSettlementSplit(players) {
  const winners = [];
  const losers = [];

  for (const player of players) {
    const entry = {
      playerId: player.playerId,
      playerName: player.playerName,
      finalPrizeAmount: player.finalPrizeAmount,
      finalBoxId: player.finalBoxId,
      finalBoxNumber: player.finalBoxNumber
    };

    if (Number(player.finalPrizeAmount || 0) > 0) {
      winners.push(entry);
    } else {
      losers.push(entry);
    }
  }

  return { winners, losers };
}

function buildRoundCounts(session, round, players) {
  return {
    registeredPlayerCountForSession: getRegisteredPlayerCountForSession(session),
    expectedPlayerCountForRound: getExpectedPlayerCountForRound(session, round),
    joinedPlayerCountForRound: getJoinedPlayerCountForRound(round, players)
  };
}

export function buildSessionCreatedPayload({ eventName, session, round, players }) {
  const economy = buildEconomy(session, round);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round?.roundId || null,
    roundNumber: round?.roundNumber || null,
    status: sessionStatusLabel(session.status),
    registeredPlayerCountForSession: getRegisteredPlayerCountForSession(session),
    stakeAmount: economy.stakeAmount,
    totalStakeAmount: economy.totalStakeAmount,
    platformFee: economy.platformFee,
    rewardPool: economy.rewardPool,
    registeredPlayerIds: [...(session.registeredPlayerIds || [])],
    players: (players || []).map((player) => buildPlayerMinimal(player)),
    roundCount: Number(session.roundCount || 0),
    currentRoundId: session.currentRoundId || null
  });
}

export function buildPlayerJoinedPayload({ eventName, session, round, players, player, reason }) {
  const counts = buildRoundCounts(session, round, players);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    player: {
      playerId: player.playerId,
      playerName: player.playerName || null,
      participationLabel: player.participationLabel || null,
      joinedAt: player.joinedAt ?? null
    },
    ...counts,
    remainingPlayersToStart: Math.max(0, counts.expectedPlayerCountForRound - counts.joinedPlayerCountForRound),
    reason
  });
}

export function buildPlayerConnectionPayload({ eventName, session, round, players, player, reason }) {
  const counts = buildRoundCounts(session, round, players);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round?.roundId || null,
    roundNumber: round?.roundNumber || null,
    player: {
      playerId: player.playerId,
      playerName: player.playerName || null,
      participationLabel: player.participationLabel || null,
      lastSeenAt: player.lastSeenAt ?? null
    },
    ...counts,
    connectedPlayerCountForRound: getConnectedPlayerCountForRound(players),
    reason
  });
}

export function buildRoundJoinWindowStartedPayload({ eventName, session, round, players, player, reason }) {
  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    reason,
    joinDeadlineAt: round.joinDeadlineAt ?? null,
    ...buildRoundCounts(session, round, players),
    player: player
      ? {
          playerId: player.playerId,
          playerName: player.playerName || null,
          participationLabel: player.participationLabel || null
        }
      : null
  });
}

export function buildRoundStartedPayload({ eventName, session, round, players, boxes, reason }) {
  const economy = buildEconomy(session, round);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    reason,
    status: roundStatusLabel(round.status),
    ...buildRoundCounts(session, round, players),
    connectedPlayerCountAtRoundStart: getConnectedPlayerCountAtRoundStart(players),
    stakeAmount: economy.stakeAmount,
    totalStakeAmount: economy.totalStakeAmount,
    platformFee: economy.platformFee,
    rewardPool: economy.rewardPool,
    distributionStartedAt: round.distributionStartedAt ?? null,
    distributionEndsAt: round.distributionEndsAt ?? null,
    distributionPackage: round.distributionPackage ?? null,
    swapPackage: round.swapPackage ?? null,
    players: (players || []).map((player) => buildPlayerRoundState(player)),
    boxes: (boxes || []).map((box) => buildBoxState(box))
  });
}

export function buildRoundSwapMatchedPayload({ eventName, session, round, players, boxes, matched }) {
  const summary = buildSwapMatchSummaries({ matched: [matched] }, players, boxes)[0];

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    ...(summary || {
      matchedAt: matched?.matchedAt ?? null,
      firstPlayer: null,
      secondPlayer: null,
      firstBoxBefore: null,
      secondBoxBefore: null,
      firstBoxAfter: null,
      secondBoxAfter: null,
      swapMatch: {
        matchedAt: matched?.matchedAt ?? null,
        firstPlayerId: matched?.firstPlayerId ?? null,
        secondPlayerId: matched?.secondPlayerId ?? null,
        firstBoxId: matched?.firstBoxId ?? null,
        secondBoxId: matched?.secondBoxId ?? null
      }
    })
  });
}

export function buildRoundCancelledPayload({
  eventName,
  session,
  round,
  players,
  minimumPlayersRequired = MINIMUM_PLAYERS_TO_START
}) {
  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    status: 'cancelled',
    endReason: round.roundEndReason || session.endReason || null,
    ...buildRoundCounts(session, round, players),
    minimumPlayersRequired,
    players: (players || []).map((player) => buildPlayerMinimal(player)),
    winners: [],
    losers: []
  });
}

export function buildRoundEndedPayload({ eventName, session, round, players, boxes, swaps }) {
  const economy = buildEconomy(session, round);
  const settledPlayers = buildRoundSettlementPlayers(players, swaps);
  const settlement = buildSettlementSplit(settledPlayers);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    status: 'ended',
    endReason: round.roundEndReason || session.endReason || null,
    ...buildRoundCounts(session, round, players),
    connectedPlayerCountAtRoundStart: getConnectedPlayerCountAtRoundStart(players),
    stakeAmount: economy.stakeAmount,
    totalStakeAmount: economy.totalStakeAmount,
    platformFee: economy.platformFee,
    rewardPool: economy.rewardPool,
    distributionStartedAt: round.distributionStartedAt ?? null,
    distributionEndsAt: round.distributionEndsAt ?? null,
    swapStartedAt: round.swapStartedAt ?? null,
    swapActionClosesAt: round.swapActionClosesAt ?? null,
    swapEndsAt: round.swapEndsAt ?? null,
    swapClosedAt: round.swapClosedAt ?? null,
    revealAt: round.revealAt ?? null,
    distributionPackage: round.distributionPackage ?? null,
    swapPackage: round.swapPackage ?? null,
    revealPackage: round.revealPackage ?? null,
    resultsPackage: round.resultsPackage ?? null,
    preResultStartedAt: round.preResultStartedAt ?? null,
    preResultReadyDeadlineAt: round.preResultReadyDeadlineAt ?? null,
    finalResultsReleaseAt: round.finalResultsReleaseAt ?? null,
    finalResultsSentAt: round.finalResultsSentAt ?? null,
    endedAt: round.endedAt ?? null,
    players: settledPlayers,
    boxes: (boxes || []).map((box) => ({
      boxId: box.boxId,
      boxNumber: box.boxNumber,
      rewardAmount: box.rewardAmount ?? 0,
      isWinningBox: !!box.isWinningBox,
      initialOwnerPlayerId: box.initialOwnerPlayerId || null,
      finalOwnerPlayerId: box.currentOwnerPlayerId || null
    })),
    swapMatches: buildSwapMatchSummaries(swaps, players, boxes),
    winners: settlement.winners,
    losers: settlement.losers
  });
}

export function buildSessionReplayWaitingPayload({ eventName, session, round, players, replayWaitMs, replayBufferMs }) {
  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    status: sessionStatusLabel(session.status),
    ...buildRoundCounts(session, round, players),
    replayWaitMs,
    replayBufferMs,
    replayPlayerIds: [...(round?.registeredPlayerIdsForRound || session?.registeredPlayerIds || [])]
  });
}

export function buildSessionReplayStartedPayload({ eventName, session, round, players, replayPlayerIds }) {
  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    status: sessionStatusLabel(session.status),
    ...buildRoundCounts(session, round, players),
    replayPlayerIds: [...(replayPlayerIds || [])]
  });
}

export function buildSessionEndedPayload({ eventName, session, round, lastRoundStatus = undefined }) {
  const economy = buildEconomy(session, round);

  return buildEnvelope(eventName, {
    sessionId: session.sessionId,
    roundId: round?.roundId || null,
    roundNumber: round?.roundNumber || null,
    status: sessionStatusLabel(session.status),
    endReason: session.endReason || null,
    roundCount: Number(session.roundCount || 0),
    lastRoundId: round?.roundId || null,
    lastRoundNumber: round?.roundNumber || null,
    lastRoundStatus: lastRoundStatus ?? lastRoundStatusLabel(round?.status),
    stakeAmount: economy.stakeAmount,
    totalStakeAmount: economy.totalStakeAmount,
    platformFee: economy.platformFee,
    endedAt: session.endedAt ?? null
  });
}
