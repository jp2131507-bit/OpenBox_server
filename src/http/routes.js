import express from 'express';
import config from '../config.js';
import { requireControlAuth } from './middleware/auth.js';
import sessionRegistry from '../runtime/sessionRegistry.js';
import redisStore from '../store/redisStore.js';
import { RoundStatus, WebhookEventType } from '../shared/protocol.js';
import {
  clearDlq,
  dispatchWebhook,
  listDlqItems,
  readDlqItem,
  resendDlqItem
} from '../webhooks/dispatcher.js';
import { validateStartPayload } from './validation.js';
import { signJsonPayload } from '../security/hmac.js';
import { buildSessionCreatedPayload } from '../webhooks/payloads.js';

const router = express.Router();

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function normalizePlayerName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 15);
}

function buildServerJoinUrl(req, sessionId) {
  return `${req.protocol}://${req.get('host')}/session/${sessionId}/join`;
}

function buildWsUrl(req) {
  const protocol = req.protocol === 'https' ? 'wss' : 'ws';
  return `${protocol}://${req.get('host')}`;
}

function buildClientLaunchUrl(req, sessionId, query = {}) {
  const url = new URL(config.clientBaseUrl);
  url.searchParams.set('joinUrl', buildServerJoinUrl(req, sessionId));
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('ws', buildWsUrl(req));

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function shouldExposeRevealData(roundStatus) {
  return [
    RoundStatus.REVEALING,
    RoundStatus.ROUND_ENDED,
    RoundStatus.ROUND_CANCELLED
  ].includes(roundStatus);
}

function buildPublicSessionState(runtime) {
  const exposeRevealData = shouldExposeRevealData(runtime.round?.status);
  const round = {
    ...runtime.round
  };

  if (!exposeRevealData) {
    delete round.auditSeed;
  }

  return {
    session: runtime.session,
    round,
    players: runtime.players,
    boxes: runtime.boxes.map((box) => ({
      boxId: box.boxId,
      boxNumber: box.boxNumber,
      initialOwnerPlayerId: box.initialOwnerPlayerId,
      currentOwnerPlayerId: box.currentOwnerPlayerId,
      ...(exposeRevealData
        ? {
            rewardAmount: box.rewardAmount,
            isWinningBox: box.isWinningBox
          }
        : {})
    }))
  };
}

async function handleSessionEndRequest(req, res) {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const result = await runtime.requestSessionEnd('manual_end');
  if (!result.ok) {
    if (result.error === 'ROUND_ONGOING') {
      res.status(409).json({
        error: 'Round is already ongoing',
        code: result.error,
        sessionStatus: result.sessionStatus,
        roundStatus: result.roundStatus
      });
      return;
    }

    res.status(400).json({
      error: result.error || 'Unable to end session',
      sessionStatus: result.sessionStatus ?? runtime.session.status,
      roundStatus: result.roundStatus ?? runtime.round?.status ?? null
    });
    return;
  }

  res.json({
    ok: true,
    sessionId: result.sessionId,
    sessionStatus: result.sessionStatus,
    roundStatus: result.roundStatus
  });
}

router.post('/session/start', requireControlAuth, asyncRoute(async (req, res) => {
  const validation = validateStartPayload(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  let runtime;
  try {
    runtime = await sessionRegistry.createSession({
      ...validation,
      platformFeeType: config.platformFeeType,
      platformFeeValue: config.platformFeeValue
    });
  } catch (error) {
    if (error?.code === 'PLAYER_ACTIVE_SESSION_CONFLICT') {
      res.status(409).json({
        error: error.message,
        code: error.code,
        playerId: error.playerId,
        activeSessionId: error.activeSessionId
      });
      return;
    }
    throw error;
  }

  await dispatchWebhook(
    WebhookEventType.SESSION_CREATED,
    buildSessionCreatedPayload({
      eventName: WebhookEventType.SESSION_CREATED,
      session: runtime.session,
      round: runtime.round,
      players: runtime.players
    })
  );

  const responsePayload = {
    sessionId: runtime.session.sessionId,
    joinUrl: buildServerJoinUrl(req, runtime.session.sessionId),
    playerCount: runtime.session.initialExpectedPlayerCount,
    stakeAmount: runtime.session.stakeAmount,
    status: runtime.session.status,
    firstJoinTimeoutMs: config.devWaitForAllPlayers ? null : config.firstJoinTimeoutMs,
    devWaitForAllPlayers: config.devWaitForAllPlayers
  };
  const signature = signJsonPayload(responsePayload);
  if (signature) {
    res.set('X-Hub-Signature-256', signature);
  }
  res.status(201).json(responsePayload);
}));

router.post('/session/:sessionId/join-intent', asyncRoute(async (req, res) => {
  const { sessionId } = req.params;
  const { playerId, playerName } = req.body || {};
  const normalizedPlayerName = normalizePlayerName(playerName);
  if (!playerId || !normalizedPlayerName) {
    res.status(400).json({ error: 'playerId and playerName are required' });
    return;
  }

  const runtime = await sessionRegistry.getOrHydrate(sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const result = await runtime.markJoinIntent({
    playerId: String(playerId),
    playerName: normalizedPlayerName
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result);
}));

router.post('/session/:sessionId/replay', requireControlAuth, asyncRoute(async (req, res) => {
  const { sessionId } = req.params;
  const playerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds.map(String) : [];
  if (playerIds.length < 2) {
    res.status(400).json({ error: 'Replay requires at least 2 unique players' });
    return;
  }
  if (new Set(playerIds).size !== playerIds.length) {
    res.status(400).json({ error: 'Replay playerIds must be unique' });
    return;
  }

  const runtime = await sessionRegistry.getOrHydrate(sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const currentSessionPlayers = new Set(runtime.session.registeredPlayerIds);
  if (playerIds.some((playerId) => !currentSessionPlayers.has(playerId))) {
    res.status(400).json({ error: 'Replay playerIds must belong to the session' });
    return;
  }

  const currentlyConnected = new Set(
    runtime.players.filter((player) => player.isConnected).map((player) => player.playerId)
  );
  if (playerIds.some((playerId) => !currentlyConnected.has(playerId))) {
    res.status(400).json({ error: 'Replay players are expected to be connected' });
    return;
  }

  await runtime.createReplayRound(playerIds);
  res.json({
    sessionId: runtime.session.sessionId,
    roundId: runtime.round.roundId,
    roundNumber: runtime.round.roundNumber,
    expectedPlayerCountForRound: runtime.round.expectedPlayerCountForRound
  });
}));

router.post('/session/:sessionId/end', requireControlAuth, asyncRoute(handleSessionEndRequest));

async function handleActiveSessions(req, res) {
  const activeSessionIds = await redisStore.getActiveSessionIds();
  const sessions = [];

  for (const sessionId of activeSessionIds) {
    const runtime = await sessionRegistry.getOrHydrate(sessionId);
    if (!runtime) continue;
    sessions.push({
      sessionId: runtime.session.sessionId,
      sessionStatus: runtime.session.status,
      roundId: runtime.round?.roundId || null,
      roundNumber: runtime.round?.roundNumber || null,
      roundStatus: runtime.round?.status || null,
      playerCount: runtime.session.currentExpectedPlayerCount,
      joinedCount: runtime.getJoinedCount(),
      readyCount: runtime.round?.readyPlayerIdsForRound?.length || 0,
      expectedReadyCount: runtime.round?.gatePlayerIdsForRound?.length || 0,
      connectedCount: runtime.players.filter((player) => player.isConnected).length,
      createdAt: runtime.session.createdAt,
      endedAt: runtime.session.endedAt || null,
      endReason: runtime.session.endReason || null
    });
  }

  res.json({
    activeCount: sessions.length,
    sessions
  });
}

router.get('/admin/sessions/active', requireControlAuth, asyncRoute(handleActiveSessions));
router.post('/admin/sessions/active', requireControlAuth, asyncRoute(handleActiveSessions));

router.post('/admin/session/:sessionId/end', requireControlAuth, asyncRoute(handleSessionEndRequest));

router.get('/admin/session/:sessionId/debug', requireControlAuth, asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const events = await redisStore.getEvents(runtime.session.sessionId, 250);
  res.json({
    snapshotRevision: runtime.session.snapshotRevision || 0,
    session: runtime.session,
    round: runtime.round,
    players: runtime.players,
    boxes: runtime.boxes,
    swaps: runtime.swaps,
    events
  });
}));

router.get('/admin/dlq', requireControlAuth, asyncRoute(async (req, res) => {
  res.json({ items: await listDlqItems() });
}));

router.get('/admin/dlq/:id', requireControlAuth, asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: 'Invalid DLQ item id' });
    return;
  }

  try {
    res.json(await readDlqItem(req.params.id));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.status(404).json({ error: 'DLQ item not found' });
      return;
    }
    throw error;
  }
}));

router.post('/admin/dlq/:id/resend', requireControlAuth, asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: 'Invalid DLQ item id' });
    return;
  }

  try {
    const { item, result } = await resendDlqItem(req.params.id);
    if (result.ok) {
      res.json({
        ok: true,
        dlqItemId: item.dlqItemId,
        eventId: item.eventId,
        eventName: item.eventName,
        endpoint: item.endpoint
      });
      return;
    }

    res.status(400).json({
      ok: false,
      dlqItemId: item.dlqItemId,
      eventId: item.eventId,
      eventName: item.eventName,
      endpoint: item.endpoint,
      error: result.error || result.reason || 'Failed to resend DLQ item',
      attempts: result.attempts,
      status: result.status ?? null
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.status(404).json({ error: 'DLQ item not found' });
      return;
    }
    throw error;
  }
}));

router.delete('/admin/dlq', requireControlAuth, asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    clearedCount: await clearDlq()
  });
}));

router.get('/session/:sessionId', asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(buildPublicSessionState(runtime));
}));

router.get('/session/:sessionId/join', asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).send('Session not found.');
    return;
  }

  const playerId = String(req.query.playerId || req.query.playerID || '').trim();
  const playerName = normalizePlayerName(req.query.playerName);
  res.redirect(302, buildClientLaunchUrl(req, req.params.sessionId, { playerId, playerName }));
}));

router.get('/health', asyncRoute(async (req, res) => {
  const activeSessions = await redisStore.getActiveSessionIds();
  res.json({ ok: true, activeSessions: activeSessions.length });
}));

router.get('/api/health', asyncRoute(async (req, res) => {
  const activeSessions = await redisStore.getActiveSessionIds();
  res.json({ ok: true, activeSessions: activeSessions.length });
}));

router.post('/api/sessions', asyncRoute(async (req, res) => {
  const playerCount = Number.parseInt(req.body?.playerCount, 10);
  const stakeAmount = Number.parseFloat(req.body?.stakeAmount);
  if (!Number.isFinite(playerCount) || playerCount < 2 || playerCount > 50) {
    res.status(400).json({ error: 'playerCount must be between 2 and 50' });
    return;
  }
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    res.status(400).json({ error: 'stakeAmount must be a positive number' });
    return;
  }

  const requestedPlayerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds.map(String) : [];
  const playerIds = requestedPlayerIds.length
    ? requestedPlayerIds
    : Array.from({ length: playerCount }, (_, index) => `player-${index + 1}`);

  const validation = validateStartPayload({
    playerCount,
    stakeAmount,
    playerIds
  });
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  let runtime;
  try {
    runtime = await sessionRegistry.createSession({
      ...validation,
      platformFeeType: config.platformFeeType,
      platformFeeValue: config.platformFeeValue
    });
  } catch (error) {
    if (error?.code === 'PLAYER_ACTIVE_SESSION_CONFLICT') {
      res.status(409).json({
        error: error.message,
        code: error.code,
        playerId: error.playerId,
        activeSessionId: error.activeSessionId
      });
      return;
    }
    throw error;
  }

  await dispatchWebhook(
    WebhookEventType.SESSION_CREATED,
    buildSessionCreatedPayload({
      eventName: WebhookEventType.SESSION_CREATED,
      session: runtime.session,
      round: runtime.round,
      players: runtime.players
    })
  );

  const joinUrl = buildServerJoinUrl(req, runtime.session.sessionId);
  res.status(201).json({
    sessionId: runtime.session.sessionId,
    joinUrl,
    clientUrl: buildClientLaunchUrl(req, runtime.session.sessionId),
    wsUrl: buildWsUrl(req),
    playerCount: runtime.session.initialExpectedPlayerCount,
    readyTimeoutMs: config.readyCheckTimeoutMs,
    softLockPercent: config.swapSoftLockPercent,
    playerIds
  });
}));

router.get('/api/sessions/:sessionId', asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(buildPublicSessionState(runtime));
}));

router.post('/api/sessions/:sessionId/end', asyncRoute(handleSessionEndRequest));

export default router;
