import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { validateEnv } from '../src/config/validateEnv.js';
import { RoundStatus, SessionStatus } from '../src/shared/protocol.js';
import { validateStartPayload } from '../src/http/validation.js';
import routes from '../src/http/routes.js';
import {
  buildRoundCancelledPayload,
  buildRoundEndedPayload,
  buildRoundStartedPayload,
  buildRoundSwapMatchedPayload,
  buildSessionCreatedPayload,
  buildSessionEndedPayload
} from '../src/webhooks/payloads.js';
import { createRound, createRoundPlayers, createSessionContainer } from '../src/domain/sessionState.js';
import sessionRegistry from '../src/runtime/sessionRegistry.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return app;
}

test('validateStartPayload accepts valid payloads', () => {
  const result = validateStartPayload({
    playerCount: 2,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2']
  });

  assert.deepEqual(result, {
    ok: true,
    playerCount: 2,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2']
  });
});

test('validateStartPayload rejects invalid player counts, mismatches, duplicates, and stake', () => {
  assert.equal(validateStartPayload({ playerCount: 1, stakeAmount: 1000, playerIds: ['p1'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 51, stakeAmount: 1000, playerIds: Array.from({ length: 51 }, (_, i) => `p${i}`) }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 2, stakeAmount: 1000, playerIds: ['p1'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 2, stakeAmount: 1000, playerIds: ['p1', 'p1'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 2, stakeAmount: 0, playerIds: ['p1', 'p2'] }).ok, false);
});

test('session join route redirects to the hosted client with required launch params', async (t) => {
  const previousClientBaseUrl = config.clientBaseUrl;
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  config.clientBaseUrl = 'https://client.example.test/play';
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'test-session', status: SessionStatus.WAITING_FOR_FIRST_JOIN },
    round: { roundId: 'round-1', status: RoundStatus.WAITING_FOR_FIRST_JOIN },
    players: [],
    boxes: []
  });

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    config.clientBaseUrl = previousClientBaseUrl;
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(
    `http://127.0.0.1:${port}/session/test-session/join?playerId=p1&playerName=Alice`,
    { redirect: 'manual' }
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('location'),
    `https://client.example.test/play?joinUrl=http%3A%2F%2F127.0.0.1%3A${port}%2Fsession%2Ftest-session%2Fjoin&sessionId=test-session&ws=ws%3A%2F%2F127.0.0.1%3A${port}&playerId=p1&playerName=Alice`
  );
});

test('session join route truncates player names in launch redirects', async (t) => {
  const previousClientBaseUrl = config.clientBaseUrl;
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  config.clientBaseUrl = 'https://client.example.test/play';
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'test-session', status: SessionStatus.WAITING_FOR_FIRST_JOIN },
    round: { roundId: 'round-1', status: RoundStatus.WAITING_FOR_FIRST_JOIN },
    players: [],
    boxes: []
  });

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    config.clientBaseUrl = previousClientBaseUrl;
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(
    `http://127.0.0.1:${port}/session/test-session/join?playerId=p1&playerName=Extra%20Long%20Player%20Name`,
    { redirect: 'manual' }
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /playerName=Extra(?:\+|%20)Long(?:\+|%20)Play$/);
});

test('session start returns a signed response when control auth succeeds', async (t) => {
  const previousControlToken = config.controlApiToken;
  const previousHmacSecret = config.hmacSecret;
  const originalCreateSession = sessionRegistry.createSession;
  config.controlApiToken = 'secret-token';
  config.hmacSecret = 'test-hmac-secret';
  sessionRegistry.createSession = async () => ({
    session: {
      sessionId: 'session-created',
      initialExpectedPlayerCount: 2,
      currentExpectedPlayerCount: 2,
      stakeAmount: 1000,
      platformFeeType: 'percentage',
      platformFeeValueSnapshot: 10,
      registeredPlayerIds: ['p1', 'p2'],
      roundCount: 1,
      currentRoundId: 'round-1',
      status: SessionStatus.WAITING_FOR_FIRST_JOIN
    },
    round: { roundId: 'round-1', roundNumber: 1, expectedPlayerCountForRound: 2 },
    players: createRoundPlayers(['p1', 'p2'])
  });

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.controlApiToken = previousControlToken;
    config.hmacSecret = previousHmacSecret;
    sessionRegistry.createSession = originalCreateSession;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/start`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      playerCount: 2,
      stakeAmount: 1000,
      playerIds: ['p1', 'p2']
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.sessionId, 'session-created');
  assert.equal(payload.playerCount, 2);
  assert.equal(payload.status, SessionStatus.WAITING_FOR_FIRST_JOIN);
  assert.match(response.headers.get('x-hub-signature-256') || '', /^[a-f0-9]{64}$/);
});

test('session start response keeps the initial waiting status even if runtime mutates during webhook delivery', async (t) => {
  const previousControlToken = config.controlApiToken;
  const previousHmacSecret = config.hmacSecret;
  const previousEndpoints = config.webhookEndpoints;
  const previousRetrySchedule = config.webhookRetryScheduleMs;
  const previousMaxAttempts = config.maxWebhookAttempts;
  const previousFetch = globalThis.fetch;
  const originalCreateSession = sessionRegistry.createSession;

  config.controlApiToken = 'secret-token';
  config.hmacSecret = 'test-hmac-secret';
  config.webhookEndpoints = ['http://webhook.test/events'];
  config.webhookRetryScheduleMs = [0];
  config.maxWebhookAttempts = 1;

  let runtimeRef;
  sessionRegistry.createSession = async () => {
    runtimeRef = {
      session: {
        sessionId: 'session-created',
        initialExpectedPlayerCount: 2,
        currentExpectedPlayerCount: 2,
        stakeAmount: 1000,
        platformFeeType: 'percentage',
        platformFeeValueSnapshot: 10,
        registeredPlayerIds: ['p1', 'p2'],
        roundCount: 1,
        currentRoundId: 'round-1',
        status: SessionStatus.WAITING_FOR_FIRST_JOIN
      },
      round: { roundId: 'round-1', roundNumber: 1, expectedPlayerCountForRound: 2 },
      players: createRoundPlayers(['p1', 'p2'])
    };
    return runtimeRef;
  };

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.controlApiToken = previousControlToken;
    config.hmacSecret = previousHmacSecret;
    config.webhookEndpoints = previousEndpoints;
    config.webhookRetryScheduleMs = previousRetrySchedule;
    config.maxWebhookAttempts = previousMaxAttempts;
    globalThis.fetch = previousFetch;
    sessionRegistry.createSession = originalCreateSession;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.startsWith(baseUrl)) {
      return previousFetch(url, options);
    }
    runtimeRef.session.status = SessionStatus.CANCELLED;
    return { ok: true, status: 200 };
  };

  const response = await fetch(`${baseUrl}/session/start`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      playerCount: 2,
      stakeAmount: 1000,
      playerIds: ['p1', 'p2']
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.status, SessionStatus.WAITING_FOR_FIRST_JOIN);
});

test('session start rejects unauthorized requests when control auth is configured', async (t) => {
  const previousControlToken = config.controlApiToken;
  config.controlApiToken = 'secret-token';

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.controlApiToken = previousControlToken;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      playerCount: 2,
      stakeAmount: 1000,
      playerIds: ['p1', 'p2']
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.error, 'Unauthorized');
});

test('replay contract rejects requests with fewer than 2 players', async (t) => {
  const previousControlToken = config.controlApiToken;
  config.controlApiToken = 'secret-token';

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.controlApiToken = previousControlToken;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/session-1/replay`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      playerIds: ['p1']
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Replay requires at least 2 unique players');
});

test('public session endpoint hides audit seed and box rewards before reveal', async (t) => {
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'session-1', status: SessionStatus.ROUND_ACTIVE },
    round: {
      roundId: 'round-1',
      status: RoundStatus.SWAP_OPEN,
      auditSeed: 'seed-hidden'
    },
    players: [{ playerId: 'p1', isConnected: true }],
    boxes: [
      {
        boxId: 'box-1',
        boxNumber: 1,
        rewardAmount: 2700,
        isWinningBox: true,
        initialOwnerPlayerId: 'p1',
        currentOwnerPlayerId: 'p1'
      }
    ]
  });

  const app = createTestApp();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/session-1`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal('auditSeed' in payload.round, false);
  assert.equal('rewardAmount' in payload.boxes[0], false);
  assert.equal('isWinningBox' in payload.boxes[0], false);
});

test('public session endpoint includes reveal data after round end', async (t) => {
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'session-1', status: SessionStatus.REPLAY_WAITING },
    round: {
      roundId: 'round-1',
      status: RoundStatus.ROUND_ENDED,
      auditSeed: 'seed-visible'
    },
    players: [{ playerId: 'p1', isConnected: true }],
    boxes: [
      {
        boxId: 'box-1',
        boxNumber: 1,
        rewardAmount: 2700,
        isWinningBox: true,
        initialOwnerPlayerId: 'p1',
        currentOwnerPlayerId: 'p1'
      }
    ]
  });

  const app = createTestApp();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/session-1`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.round.auditSeed, 'seed-visible');
  assert.equal(payload.boxes[0].rewardAmount, 2700);
  assert.equal(payload.boxes[0].isWinningBox, true);
});

test('buildSessionCreatedPayload normalizes session bootstrap details', () => {
  const session = createSessionContainer({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  const round = createRound({
    sessionId: session.sessionId,
    roundNumber: 1,
    playerIds: session.registeredPlayerIds
  });
  const players = createRoundPlayers(session.registeredPlayerIds);

  players[0].playerName = 'Alice';
  players[0].isConnected = true;
  players[0].hasJoinedRound = true;

  const payload = buildSessionCreatedPayload({
    eventName: 'session.created',
    session,
    round,
    players
  });

  assert.equal(payload.eventName, 'session.created');
  assert.equal(payload.eventVersion, 1);
  assert.equal(payload.registeredPlayerCountForSession, 5);
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal(payload.rewardPool, 4500);
  assert.equal(payload.players.length, 5);
  assert.equal(payload.currentRoundId, session.currentRoundId);
});

test('buildRoundStartedPayload includes normalized economy, players, and boxes', () => {
  const session = {
    sessionId: 's1',
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValueSnapshot: 10,
    registeredPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
  const round = {
    roundId: 'r1',
    roundNumber: 1,
    expectedPlayerCountForRound: 5,
    joinedPlayerIdsForRound: ['p1', 'p2', 'p3', 'p4', 'p5'],
    status: RoundStatus.DISTRIBUTING,
    grossStakeTotal: 5000,
    feeAmount: 500,
    rewardPool: 4500,
    distributionStartedAt: 1000,
    distributionEndsAt: 4000,
    distributionPackage: { phase: 'distribution' },
    swapPackage: { phase: 'swap' }
  };
  const players = [
    {
      playerId: 'p1',
      playerName: 'Alice',
      hasJoinedRound: true,
      connectedAtStartOfRound: true,
      initialBoxId: 'b1',
      initialBoxNumber: 1,
      finalBoxId: 'b2',
      finalBoxNumber: 2,
      swapRequested: true,
      swapMatched: true,
      finalPrizeAmount: 2700,
      isWinner: true
    },
    {
      playerId: 'p2',
      playerName: 'Bob',
      hasJoinedRound: false,
      connectedAtStartOfRound: false,
      initialBoxId: 'b2',
      initialBoxNumber: 2,
      participationLabel: 'REGISTERED_ABSENT'
    }
  ];
  const boxes = [
    {
      boxId: 'b1',
      boxNumber: 1,
      rewardAmount: 0,
      isWinningBox: false,
      initialOwnerPlayerId: 'p1',
      currentOwnerPlayerId: 'p2'
    },
    {
      boxId: 'b2',
      boxNumber: 2,
      rewardAmount: 2700,
      isWinningBox: true,
      initialOwnerPlayerId: 'p2',
      currentOwnerPlayerId: 'p1'
    }
  ];

  const payload = buildRoundStartedPayload({
    eventName: 'round.started',
    session,
    round,
    players,
    boxes,
    reason: 'all_players_joined'
  });

  assert.equal(payload.eventName, 'round.started');
  assert.equal(payload.status, 'distributing');
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.feeAmount, 500);
  assert.equal(payload.rewardPool, 4500);
  assert.equal(payload.connectedPlayerCountAtRoundStart, 1);
  assert.equal(payload.players.length, 2);
  assert.equal(payload.boxes.length, 2);
  assert.equal(payload.distributionStartedAt, 1000);
  assert.equal(payload.distributionPackage.phase, 'distribution');
  assert.equal(payload.swapPackage.phase, 'swap');
});

test('buildRoundSwapMatchedPayload includes before and after box ownership summaries', () => {
  const session = { sessionId: 's1' };
  const round = { roundId: 'r1', roundNumber: 1 };
  const players = [
    { playerId: 'p1', playerName: 'Alice' },
    { playerId: 'p2', playerName: 'Bob' }
  ];
  const boxes = [
    { boxId: 'b1', boxNumber: 1, rewardAmount: 0, isWinningBox: false, initialOwnerPlayerId: 'p1', currentOwnerPlayerId: 'p2' },
    { boxId: 'b2', boxNumber: 2, rewardAmount: 2700, isWinningBox: true, initialOwnerPlayerId: 'p2', currentOwnerPlayerId: 'p1' }
  ];

  const payload = buildRoundSwapMatchedPayload({
    eventName: 'round.swap_matched',
    session,
    round,
    players,
    boxes,
    matched: {
      matchedAt: 1234,
      firstPlayerId: 'p1',
      secondPlayerId: 'p2',
      firstBoxId: 'b1',
      secondBoxId: 'b2'
    }
  });

  assert.equal(payload.firstPlayer.playerName, 'Alice');
  assert.equal(payload.secondPlayer.playerName, 'Bob');
  assert.equal(payload.firstBoxBefore.boxId, 'b1');
  assert.equal(payload.firstBoxAfter.boxId, 'b2');
  assert.equal(payload.swapMatch.firstPlayerId, 'p1');
});

test('buildRoundEndedPayload includes winners, losers, platform fee, and swap summaries', () => {
  const session = {
    sessionId: 's1',
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValueSnapshot: 10,
    registeredPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
  const round = {
    roundId: 'r1',
    roundNumber: 1,
    expectedPlayerCountForRound: 5,
    joinedPlayerIdsForRound: ['p1', 'p2'],
    grossStakeTotal: 5000,
    feeAmount: 500,
    rewardPool: 4500,
    distributionStartedAt: 1000,
    distributionEndsAt: 4000,
    swapStartedAt: 4000,
    swapActionClosesAt: 6100,
    swapEndsAt: 7000,
    swapClosedAt: 7100,
    finalResultsReleaseAt: 14300,
    finalResultsSentAt: 14350,
    endedAt: 14350,
    roundEndReason: 'completed'
  };
  const players = [
    {
      playerId: 'p1',
      playerName: 'Alice',
      hasJoinedRound: true,
      isConnected: true,
      connectedAtStartOfRound: true,
      participationLabel: 'ROUND_COMPLETE',
      initialBoxId: 'b1',
      initialBoxNumber: 1,
      finalBoxId: 'b2',
      finalBoxNumber: 2,
      swapRequested: true,
      swapMatched: true,
      finalPrizeAmount: 2700,
      isWinner: true
    },
    {
      playerId: 'p2',
      playerName: 'Bob',
      hasJoinedRound: true,
      isConnected: false,
      connectedAtStartOfRound: false,
      participationLabel: 'ROUND_COMPLETE',
      initialBoxId: 'b2',
      initialBoxNumber: 2,
      finalBoxId: 'b1',
      finalBoxNumber: 1,
      swapRequested: false,
      swapMatched: true,
      finalPrizeAmount: 0,
      isWinner: false
    }
  ];
  const boxes = [
    {
      boxId: 'b1',
      boxNumber: 1,
      rewardAmount: 0,
      isWinningBox: false,
      initialOwnerPlayerId: 'p1',
      currentOwnerPlayerId: 'p2'
    },
    {
      boxId: 'b2',
      boxNumber: 2,
      rewardAmount: 2700,
      isWinningBox: true,
      initialOwnerPlayerId: 'p2',
      currentOwnerPlayerId: 'p1'
    }
  ];
  const swaps = {
    matched: [{ matchedAt: 5555, firstPlayerId: 'p1', secondPlayerId: 'p2', firstBoxId: 'b1', secondBoxId: 'b2' }]
  };

  const payload = buildRoundEndedPayload({
    eventName: 'round.ended',
    session,
    round,
    players,
    boxes,
    swaps
  });

  assert.equal(payload.eventName, 'round.ended');
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal(payload.players.length, 2);
  assert.equal(payload.boxes.length, 2);
  assert.equal(payload.swapMatches.length, 1);
  assert.equal(payload.winners.length, 1);
  assert.equal(payload.losers.length, 1);
  assert.equal(payload.players[0].swapMatchedWithPlayerId, 'p2');
  assert.equal(payload.winners[0].playerId, 'p1');
  assert.equal(payload.losers[0].playerId, 'p2');
});

test('buildRoundCancelledPayload stays lightweight and exposes empty winners and losers', () => {
  const payload = buildRoundCancelledPayload({
    eventName: 'round.cancelled',
    session: {
      sessionId: 's1',
      registeredPlayerIds: ['p1', 'p2', 'p3']
    },
    round: {
      roundId: 'r1',
      roundNumber: 1,
      expectedPlayerCountForRound: 3,
      joinedPlayerIdsForRound: ['p1'],
      roundEndReason: 'session_max_lifetime_exceeded'
    },
    players: [
      { playerId: 'p1', playerName: 'Alice', hasJoinedRound: true },
      { playerId: 'p2', playerName: 'Bob', hasJoinedRound: false }
    ]
  });

  assert.equal(payload.eventName, 'round.cancelled');
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.players.length, 2);
  assert.deepEqual(payload.winners, []);
  assert.deepEqual(payload.losers, []);
  assert.equal('boxes' in payload, false);
  assert.equal('swapMatches' in payload, false);
});

test('buildSessionEndedPayload stays lightweight and references only the last round', () => {
  const payload = buildSessionEndedPayload({
    eventName: 'session.ended',
    session: {
      sessionId: 's1',
      stakeAmount: 1000,
      platformFeeType: 'fixed',
      platformFeeValueSnapshot: 500,
      currentExpectedPlayerCount: 5,
      roundCount: 3,
      endReason: 'replay_timeout',
      endedAt: 20000
    },
    round: {
      roundId: 'r3',
      roundNumber: 3,
      status: RoundStatus.ROUND_ENDED,
      grossStakeTotal: 5000,
      feeAmount: 500
    }
  });

  assert.equal(payload.eventName, 'session.ended');
  assert.equal(payload.roundCount, 3);
  assert.equal(payload.lastRoundId, 'r3');
  assert.equal(payload.lastRoundNumber, 3);
  assert.equal(payload.lastRoundStatus, 'ended');
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal('players' in payload, false);
  assert.equal('boxes' in payload, false);
});

test('buildSessionEndedPayload supports explicit cancelled lastRoundStatus', () => {
  const payload = buildSessionEndedPayload({
    eventName: 'session.ended',
    lastRoundStatus: 'cancelled',
    session: {
      sessionId: 's1',
      stakeAmount: 1000,
      platformFeeType: 'fixed',
      platformFeeValueSnapshot: 500,
      currentExpectedPlayerCount: 5,
      roundCount: 1,
      endReason: 'manual_end',
      endedAt: 20000,
      status: SessionStatus.CANCELLED
    },
    round: {
      roundId: 'r1',
      roundNumber: 1,
      status: RoundStatus.ROUND_CANCELLED,
      grossStakeTotal: 5000,
      feeAmount: 500
    }
  });

  assert.equal(payload.lastRoundStatus, 'cancelled');
  assert.equal(payload.status, 'cancelled');
});

test('session end route rejects requests while a round is already ongoing', async (t) => {
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  sessionRegistry.getOrHydrate = async () => ({
    requestSessionEnd: async () => ({
      ok: false,
      error: 'ROUND_ONGOING',
      sessionStatus: SessionStatus.ROUND_ACTIVE,
      roundStatus: RoundStatus.SWAP_OPEN
    })
  });

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/end`, {
    method: 'POST'
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, 'ROUND_ONGOING');
  assert.equal(payload.sessionStatus, SessionStatus.ROUND_ACTIVE);
  assert.equal(payload.roundStatus, RoundStatus.SWAP_OPEN);
});

test('validateEnv accepts the current timing config and rejects invalid distribution timings', () => {
  const previousDistributionLead = config.distributionLeadMs;
  const previousCalcDelay = config.calcDelayMs;

  try {
    assert.doesNotThrow(() => validateEnv());
    assert.equal('preResultReadyTimeoutMs' in config, false);

    config.distributionLeadMs = 0;
    assert.throws(() => validateEnv(), /DISTRIBUTION_LEAD_MS/);

    config.distributionLeadMs = previousDistributionLead;
    config.calcDelayMs = 0;
    assert.throws(() => validateEnv(), /CALC_DELAY_MS/);
  } finally {
    config.distributionLeadMs = previousDistributionLead;
    config.calcDelayMs = previousCalcDelay;
  }
});

test('admin dlq routes list, inspect, resend, and clear items behind control auth', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-box-admin-dlq-'));
  const previousDlqDir = config.dlqDir;
  const previousControlToken = config.controlApiToken;
  const previousFetch = globalThis.fetch;
  config.dlqDir = tempDir;
  config.controlApiToken = 'secret-token';

  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.dlqDir = previousDlqDir;
    config.controlApiToken = previousControlToken;
    globalThis.fetch = previousFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  const dlqItemId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(
    path.join(tempDir, `${dlqItemId}.json`),
    JSON.stringify({
      dlqItemId,
      failedAt: new Date().toISOString(),
      endpoint: 'http://example.test/webhook',
      eventId: 'event-1',
      eventName: 'round.ended',
      reason: 'Permanent failure with status 401',
      lastResponseStatus: 401,
      deliveryAttempts: [],
      webhookPayload: {
        eventId: 'event-1',
        eventName: 'round.ended',
        eventVersion: 1,
        occurredAt: Date.now(),
        sessionId: 'session-1',
        roundId: 'round-1',
        roundNumber: 1
      }
    }, null, 2)
  );

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.startsWith(baseUrl)) {
      return previousFetch(url, options);
    }
    return { ok: true, status: 200 };
  };
  const headers = { authorization: 'Bearer secret-token' };

  const listResponse = await fetch(`${baseUrl}/admin/dlq`, { headers });
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.items.length, 1);
  assert.equal(listPayload.items[0].dlqItemId, dlqItemId);

  const getResponse = await fetch(`${baseUrl}/admin/dlq/${dlqItemId}`, { headers });
  const getPayload = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.equal(getPayload.eventName, 'round.ended');

  const resendResponse = await fetch(`${baseUrl}/admin/dlq/${dlqItemId}/resend`, {
    method: 'POST',
    headers
  });
  const resendPayload = await resendResponse.json();
  assert.equal(resendResponse.status, 200);
  assert.equal(resendPayload.ok, true);
  assert.equal((await fs.readdir(tempDir)).length, 0);

  await fs.writeFile(
    path.join(tempDir, `${dlqItemId}.json`),
    JSON.stringify({
      dlqItemId,
      failedAt: new Date().toISOString(),
      endpoint: 'http://example.test/webhook',
      eventId: 'event-2',
      eventName: 'session.ended',
      reason: 'Exhausted 3 retry attempts.',
      lastResponseStatus: 503,
      deliveryAttempts: [],
      webhookPayload: {
        eventId: 'event-2',
        eventName: 'session.ended',
        eventVersion: 1,
        occurredAt: Date.now(),
        sessionId: 'session-2',
        roundId: 'round-2',
        roundNumber: 2
      }
    }, null, 2)
  );

  const clearResponse = await fetch(`${baseUrl}/admin/dlq`, {
    method: 'DELETE',
    headers
  });
  const clearPayload = await clearResponse.json();
  assert.equal(clearResponse.status, 200);
  assert.equal(clearPayload.clearedCount, 1);
});
