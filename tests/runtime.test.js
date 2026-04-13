import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { ClientMessageType, RoundStatus, ServerMessageType, SessionStatus, SwapState } from '../src/shared/protocol.js';
import {
  clearRuntimeTimers,
  createFakeSocket,
  createRuntimeFixture,
  installRedisStoreStubs
} from './helpers/runtimeHarness.js';

function withStubbedStore(t) {
  const stub = installRedisStoreStubs();
  const previousEndpoints = config.webhookEndpoints;
  const previousRetrySchedule = config.webhookRetryScheduleMs;
  const previousMaxAttempts = config.maxWebhookAttempts;
  const previousMatchmakingUrl = config.matchmakingServiceUrl;
  const previousConsoleLog = console.log;

  config.webhookEndpoints = [];
  config.webhookRetryScheduleMs = [0];
  config.maxWebhookAttempts = 1;
  config.matchmakingServiceUrl = '';
  console.log = () => {};

  t.after(() => stub.restore());
  t.after(() => {
    config.webhookEndpoints = previousEndpoints;
    config.webhookRetryScheduleMs = previousRetrySchedule;
    config.maxWebhookAttempts = previousMaxAttempts;
    config.matchmakingServiceUrl = previousMatchmakingUrl;
    console.log = previousConsoleLog;
  });
  return stub;
}

function withConfigOverride(t, key, value) {
  const previous = config[key];
  config[key] = value;
  t.after(() => {
    config[key] = previous;
  });
}

function withWebhookCapture(t) {
  const events = [];
  const previousFetch = globalThis.fetch;
  const previousEndpoints = config.webhookEndpoints;
  const previousRetrySchedule = config.webhookRetryScheduleMs;
  const previousMaxAttempts = config.maxWebhookAttempts;

  config.webhookEndpoints = ['http://webhook.test/events'];
  config.webhookRetryScheduleMs = [0];
  config.maxWebhookAttempts = 1;
  globalThis.fetch = async (_url, options = {}) => {
    events.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };

  t.after(() => {
    config.webhookEndpoints = previousEndpoints;
    config.webhookRetryScheduleMs = previousRetrySchedule;
    config.maxWebhookAttempts = previousMaxAttempts;
    globalThis.fetch = previousFetch;
  });

  return events;
}

async function joinPlayers(runtime, playerIds) {
  for (const playerId of playerIds) {
    await runtime.markJoinIntent({ playerId, playerName: playerId });
  }
}

async function readyPlayers(runtime, playerIds) {
  for (const playerId of playerIds) {
    await runtime.handleRoundReady(playerId);
  }
}

async function joinAndReadyAll(runtime, playerIds) {
  await joinPlayers(runtime, playerIds);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  await readyPlayers(runtime, playerIds);
  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  runtime.clearAllTimers();
}

function messagesOf(ws, type) {
  return ws.sent.filter((entry) => entry.type === type);
}

test('first join intent starts the join window countdown', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', false);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const result = await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(result.ok, true);
  assert.equal(runtime.round.status, RoundStatus.JOIN_WINDOW_OPEN);
  assert.equal(runtime.session.status, SessionStatus.ROUND_ACTIVE);
  assert.equal(runtime.round.joinedPlayerIdsForRound.length, 1);
  assert.ok(runtime.round.joinDeadlineAt > runtime.round.firstJoinAt);
});

test('join deadline below minimum cancels the session', async (t) => {
  const stub = withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', false);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3'] });
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.markJoinIntent({ playerId: 'p1', playerName: 'P1' });

  await runtime.handleJoinDeadline();

  assert.equal(runtime.round.status, RoundStatus.ROUND_CANCELLED);
  assert.equal(runtime.session.status, SessionStatus.CANCELLED);
  assert.equal(runtime.session.endReason, 'joined_below_minimum');
  assert.equal(stub.calls.some((entry) => entry[0] === 'removeActiveSession'), true);
  assert.equal(stub.calls.some((entry) => entry[0] === 'releasePlayerActiveSession'), true);
});

test('dev wait mode stays in join window until all players join, then enters ready check', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', true);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const result = await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(result.ok, true);
  assert.equal(runtime.round.status, RoundStatus.JOIN_WINDOW_OPEN);
  assert.equal(runtime.round.joinDeadlineAt, null);
  assert.equal(runtime.timers.joinDeadline, null);

  await joinPlayers(runtime, ['p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  await readyPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
});

test('hello sends welcome and ready_status for registered players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  assert.equal(ws.sent[0].type, ServerMessageType.WELCOME);
  assert.equal(ws.sent[1].type, ServerMessageType.READY_STATUS);
  assert.equal(runtime.connections.get('p1'), ws);
});

test('player names are normalized and truncated to 15 characters', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.markJoinIntent({
    playerId: 'p1',
    playerName: '  Extra   Long   Player   Name  '
  });

  assert.equal(runtime.players.find((player) => player.playerId === 'p1').playerName, 'Extra Long Play');
});

test('timer_end is accepted as a no-op for demo client compatibility', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });
  ws.sent = [];

  await runtime.handleSocketMessage(ws, { type: ClientMessageType.TIMER_END });

  assert.equal(ws.sent.length, 0);
});

test('join and ready updates only rebroadcast ready_status', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });
  ws1.sent = [];
  ws2.sent = [];

  await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });
  await runtime.markJoinIntent({ playerId: 'p2', playerName: 'Bob' });

  const readyUpdates = messagesOf(ws1, ServerMessageType.READY_STATUS);
  assert.equal(readyUpdates.length >= 2, true);
  assert.equal(readyUpdates[0].joinedCount, 1);
  assert.equal(readyUpdates.at(-1).joinedCount, 2);
  assert.equal(ws1.sent.some((entry) => entry.type === ServerMessageType.SESSION_INIT), false);
  assert.equal(ws1.sent.some((entry) => entry.type === ServerMessageType.SWAP_RESULT), false);
});

test('round start sends exactly one session_init per connected player', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });
  ws1.sent = [];
  ws2.sent = [];

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  await readyPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  runtime.clearAllTimers();

  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.equal(runtime.round.grossStakeTotal, 5000);
  assert.ok(runtime.round.distributionStartedAt > 0);
  assert.ok(runtime.round.distributionEndsAt > runtime.round.distributionStartedAt);
  assert.ok(runtime.round.swapStartedAt >= runtime.round.distributionEndsAt);
  assert.ok(runtime.round.swapActionClosesAt > runtime.round.swapStartedAt);
  assert.ok(runtime.round.swapEndsAt > runtime.round.swapActionClosesAt);

  const init1 = messagesOf(ws1, ServerMessageType.SESSION_INIT);
  const init2 = messagesOf(ws2, ServerMessageType.SESSION_INIT);
  assert.equal(init1.length, 1);
  assert.equal(init2.length, 1);
  assert.equal(init1[0].playerBox, runtime.players.find((player) => player.playerId === 'p1').initialBoxNumber);
  assert.equal(init2[0].playerBox, runtime.players.find((player) => player.playerId === 'p2').initialBoxNumber);
});

test('late join intent after round start is accepted without mutating joined count', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.startRound('test');
  runtime.clearAllTimers();

  const joinedCountBefore = runtime.getJoinedCount();
  const result = await runtime.markJoinIntent({ playerId: 'p6', playerName: 'Late Player' });

  assert.equal(result.ok, true);
  assert.equal(result.lateJoin, true);
  assert.equal(runtime.getJoinedCount(), joinedCountBefore);
  assert.equal(runtime.players.find((player) => player.playerId === 'p6').playerName, 'Late Player');
});

test('startRound counts absent registered players in economy and box assignment', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.startRound('test');
  runtime.clearAllTimers();

  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.equal(runtime.round.grossStakeTotal, 6000);
  assert.equal(runtime.players.length, 6);
  assert.equal(runtime.boxes.length, 6);

  const absent = runtime.players.find((player) => player.playerId === 'p6');
  assert.equal(absent.hasJoinedRound, false);
  assert.ok(absent.assignedBoxId);
  assert.ok(absent.currentBoxId);
});

test('swap window computes soft lock from total swap time and percent', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'swapPhaseMs', 1000);
  withConfigOverride(t, 'swapSoftLockPercent', 30);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();

  assert.equal(runtime.round.status, RoundStatus.SWAP_OPEN);
  assert.equal(runtime.round.swapActionClosesAt - runtime.round.swapStartedAt, 700);
  assert.equal(runtime.round.swapEndsAt - runtime.round.swapStartedAt, 1000);
});

test('swap flow supports pending, matched, and keep states using swap_result messages', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  const ws3 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });
  await runtime.handleHello(ws3, { playerId: 'p3', playerName: 'Cara' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();
  ws1.sent = [];
  ws2.sent = [];
  ws3.sent = [];

  const pending = await runtime.handleSwapRequest('p1');
  assert.equal(pending.pending, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.PENDING);
  assert.equal(messagesOf(ws1, ServerMessageType.SWAP_RESULT).length, 0);

  const matched = await runtime.handleSwapRequest('p2');
  assert.equal(matched.ok, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.MATCHED);
  assert.equal(runtime.players.find((player) => player.playerId === 'p2').swapState, SwapState.MATCHED);
  assert.equal(messagesOf(ws1, ServerMessageType.SWAP_RESULT)[0].outcome, 'found');
  assert.equal(messagesOf(ws2, ServerMessageType.SWAP_RESULT)[0].outcome, 'found');

  const kept = await runtime.handleKeepBox('p3');
  assert.equal(kept.ok, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p3').swapState, SwapState.KEPT);
});

test('softlock sends softlock and not_found outcomes without a snapshot fallback', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();
  ws1.sent = [];
  ws2.sent = [];

  await runtime.handleSwapRequest('p1');
  const result = await runtime.applySwapSoftLock();

  assert.deepEqual(result.unmatchedPlayerIds, ['p1']);
  assert.equal(result.autoKeptPlayerIds.includes('p2'), true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.UNMATCHED);
  assert.equal(runtime.players.find((player) => player.playerId === 'p2').swapState, SwapState.KEPT);

  const p1Softlock = messagesOf(ws1, ServerMessageType.SOFTLOCK)[0];
  const p1SwapResult = messagesOf(ws1, ServerMessageType.SWAP_RESULT)[0];
  const p2Softlock = messagesOf(ws2, ServerMessageType.SOFTLOCK)[0];
  assert.equal(p1Softlock.priorSwapState, 'PENDING');
  assert.equal(p1SwapResult.outcome, 'not_found');
  assert.equal(p2Softlock.priorSwapState, 'NONE');
});

test('swap requests fail after the soft-lock cutoff', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();
  runtime.round.swapActionClosesAt = Date.now() - 1;

  const result = await runtime.handleSwapRequest('p1');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'SOFTLOCK_ACTIVE');
});

test('closeSwapWindow preserves settled outcomes and round_result unlocks leaderboard_data', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();
  ws.sent = [];

  await runtime.handleSwapRequest('p1');
  await runtime.applySwapSoftLock();
  await runtime.closeSwapWindow();
  runtime.clearAllTimers();

  assert.equal(runtime.round.status, RoundStatus.SWAP_CLOSED);
  assert.ok(runtime.round.swapClosedAt > 0);
  assert.ok(runtime.round.finalResultsReleaseAt >= runtime.round.swapClosedAt);

  await runtime.publishResults();

  assert.equal(runtime.round.status, RoundStatus.ROUND_ENDED);
  assert.equal(runtime.session.status, SessionStatus.REPLAY_WAITING);
  assert.equal(runtime.players.every((player) => player.finalBoxNumber != null), true);
  assert.equal(runtime.players.every((player) => player.finalPrizeAmount != null), true);

  const roundResult = messagesOf(ws, ServerMessageType.ROUND_RESULT).at(-1);
  assert.ok(roundResult);
  assert.ok(['win', 'lose'].includes(roundResult.result));

  ws.sent = [];
  await runtime.handleSocketMessage(ws, { type: 'leaderboard_request' });
  const leaderboard = messagesOf(ws, ServerMessageType.LEADERBOARD_DATA)[0];
  assert.ok(leaderboard);
  assert.equal(leaderboard.totalPlayers, runtime.round.expectedPlayerCountForRound);
});

test('reconnecting during an active or ended round replays session_init and settled messages', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.clearAllTimers();
  await runtime.handleSwapRequest('p1');
  await runtime.applySwapSoftLock();
  await runtime.closeSwapWindow();
  runtime.clearAllTimers();
  await runtime.publishResults();

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  assert.equal(messagesOf(ws, ServerMessageType.WELCOME).length, 1);
  assert.equal(messagesOf(ws, ServerMessageType.READY_STATUS).length, 1);
  assert.equal(messagesOf(ws, ServerMessageType.SESSION_INIT).length, 1);
  assert.equal(messagesOf(ws, ServerMessageType.SWAP_RESULT).length, 1);
  assert.equal(messagesOf(ws, ServerMessageType.ROUND_RESULT).length, 1);
});

test('createReplayRound reuses the session and creates a new round', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  const originalSessionId = runtime.session.sessionId;
  const originalRoundId = runtime.round.roundId;
  await runtime.createReplayRound(['p1', 'p2', 'p3', 'p4', 'p5']);
  runtime.clearAllTimers();

  assert.equal(runtime.session.sessionId, originalSessionId);
  assert.notEqual(runtime.round.roundId, originalRoundId);
  assert.equal(runtime.round.expectedPlayerCountForRound, 5);
  assert.equal(runtime.session.currentExpectedPlayerCount, 5);
  assert.equal(runtime.session.status, SessionStatus.WAITING_FOR_FIRST_JOIN);
});

test('createReplayRound supports replaying with only 2 connected players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3'] });
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.createReplayRound(['p1', 'p2']);
  runtime.clearAllTimers();

  assert.equal(runtime.round.expectedPlayerCountForRound, 2);
  assert.equal(runtime.session.currentExpectedPlayerCount, 2);
  assert.deepEqual(runtime.session.registeredPlayerIds, ['p1', 'p2']);
});

test('createReplayRound releases locks for players excluded from replay', async (t) => {
  const stub = withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.createReplayRound(['p1', 'p2', 'p3', 'p4', 'p5']);
  runtime.clearAllTimers();

  assert.equal(runtime.session.registeredPlayerIds.includes('p6'), false);
  assert.equal(
    stub.calls.some(
      (entry) => entry[0] === 'releasePlayerActiveSession' && entry[1] === 'p6' && entry[2] === runtime.session.sessionId
    ),
    true
  );
});

test('heartbeat timeout disconnects stale players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const stalePlayer = runtime.players.find((player) => player.playerId === 'p1');
  stalePlayer.isConnected = true;
  stalePlayer.lastSeenAt = Date.now() - (config.heartbeatTimeoutMs + 500);

  await runtime.handleHeartbeatTimeouts(Date.now());

  assert.equal(stalePlayer.isConnected, false);
});

test('join and connection lifecycle emit normalized webhook events', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(events.some((entry) => entry.eventName === 'player.joined'), true);
  assert.equal(events.some((entry) => entry.eventName === 'round.join_window_started'), true);

  await runtime.handleHello(createFakeSocket(), { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleDisconnect('p1', 'socket_close');
  await runtime.handleHello(createFakeSocket(), { playerId: 'p1', playerName: 'Alice' });

  assert.equal(events.some((entry) => entry.eventName === 'player.disconnected'), true);
  assert.equal(events.some((entry) => entry.eventName === 'player.reconnected'), true);
});

test('pre-round lifetime expiry cancels then ends the session with ordered webhooks', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  withConfigOverride(t, 'sessionInactivityTimeoutMs', 1);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  runtime.session.createdAt = Date.now() - 10;
  await runtime.handlePreRoundLifetimeExpiry();

  assert.equal(runtime.round.status, RoundStatus.ROUND_CANCELLED);
  assert.equal(runtime.session.status, SessionStatus.CANCELLED);
  assert.equal(runtime.session.endReason, 'session_max_lifetime_exceeded');
  assert.deepEqual(
    events.map((entry) => entry.eventName),
    ['round.cancelled', 'session.ended']
  );
  assert.equal(events[0].winners.length, 0);
  assert.equal(events[0].losers.length, 0);
  assert.equal(events[1].lastRoundStatus, 'cancelled');
});

test('pre-round lifetime timer is cleared once the round starts', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'sessionInactivityTimeoutMs', 60000);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  assert.notEqual(runtime.timers.preRoundLifetime, null);

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);

  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.equal(runtime.timers.preRoundLifetime, null);
});

test('manual session end before round start cancels then ends', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const result = await runtime.requestSessionEnd('manual_end');

  assert.equal(result.ok, true);
  assert.equal(runtime.round.status, RoundStatus.ROUND_CANCELLED);
  assert.equal(runtime.session.status, SessionStatus.CANCELLED);
  assert.deepEqual(
    events.map((entry) => entry.eventName),
    ['round.cancelled', 'session.ended']
  );
  assert.equal(events[1].lastRoundStatus, 'cancelled');
});

test('manual session end rejects while round is ongoing', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);

  const result = await runtime.requestSessionEnd('manual_end');

  assert.deepEqual(result, {
    ok: false,
    error: 'ROUND_ONGOING',
    sessionStatus: SessionStatus.ROUND_ACTIVE,
    roundStatus: RoundStatus.DISTRIBUTING
  });
});

test('ending an already cancelled round emits only session.ended with cancelled lastRoundStatus', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  runtime.clearAllTimers();
  runtime.round.status = RoundStatus.ROUND_CANCELLED;
  runtime.round.roundEndReason = 'joined_below_minimum';
  runtime.round.endedAt = Date.now();
  runtime.session.status = SessionStatus.CANCELLED;

  const result = await runtime.requestSessionEnd('manual_end');

  assert.equal(result.ok, true);
  assert.equal(runtime.session.status, SessionStatus.ENDED);
  assert.deepEqual(events.map((entry) => entry.eventName), ['session.ended']);
  assert.equal(events[0].lastRoundStatus, 'cancelled');
});

test('ending an already ended round emits only session.ended with ended lastRoundStatus', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  runtime.clearAllTimers();
  runtime.round.status = RoundStatus.ROUND_ENDED;
  runtime.round.endedAt = Date.now();
  runtime.session.status = SessionStatus.REPLAY_WAITING;

  const result = await runtime.requestSessionEnd('manual_end');

  assert.equal(result.ok, true);
  assert.equal(runtime.session.status, SessionStatus.ENDED);
  assert.deepEqual(events.map((entry) => entry.eventName), ['session.ended']);
  assert.equal(events[0].lastRoundStatus, 'ended');
});

test('resumeTimers restores the pre-round lifetime timer for hydrated pre-start sessions', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'sessionInactivityTimeoutMs', 60000);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  runtime.clearAllTimers();

  await runtime.resumeTimers();

  assert.notEqual(runtime.timers.preRoundLifetime, null);
});

test('endSession marks the session ended and clears active index', async (t) => {
  const stub = withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.endSession('manual_end');

  assert.equal(runtime.session.status, SessionStatus.ENDED);
  assert.equal(runtime.session.endReason, 'manual_end');
  assert.equal(stub.calls.some((entry) => entry[0] === 'removeActiveSession'), true);
  assert.equal(stub.calls.some((entry) => entry[0] === 'releasePlayerActiveSession'), true);
});
