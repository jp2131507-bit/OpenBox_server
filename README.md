# Open Box Game Server Implementation Guide

## Overview

This document is for developers integrating directly with the Open Box game server.

It covers:

- control API endpoints
- player launch and join flow
- replay flow
- webhook delivery and verification
- DLQ administration
- how to build your own matchmaking server on top of Open Box


## What The Open Box Server Provides

The Open Box server is the game authority. It owns:

- session creation
- round lifecycle
- ready check before distribution
- box allocation
- swap resolution
- replay windows
- final round settlement
- webhook delivery
- webhook DLQ storage and replay

The server does not provide a full player queue or public matchmaking product. If you need queueing, room fill logic, or a custom launcher shell, build that outside the game server and use the APIs and webhooks documented here.

## Configuration

Important environment variables in `.env`:

- `PORT`
- `CONTROL_API_TOKEN`
- `HMAC_SECRET`
- `CLIENT_BASE_URL`  (u can ignore this)
- `CLIENT_ORIGIN`
- `MATCHMAKING_SERVICE_URL`
- `SESSION_INACTIVITY_TIMEOUT_MS`
- `WEBHOOK_ENDPOINTS`
- `READY_CHECK_TIMEOUT_MS`
- `FIRST_JOIN_TIMEOUT_MS`
- `REPLAY_WAIT_MS`
- `REPLAY_BUFFER_MS`
- `WEBHOOK_TIMEOUT_MS`
- `MAX_WEBHOOK_ATTEMPTS`
- `RETRY_SCHEDULE_MS`
- `DLQ_RETENTION_MS`
- `DLQ_SWEEP_INTERVAL_MS`
- `PLATFORM_FEE_TYPE`
- `PLATFORM_FEE_VALUE`

Important defaults from the current server:

- `SESSION_INACTIVITY_TIMEOUT_MS=120000` in local `.env`
- `READY_CHECK_TIMEOUT_MS=10000`
- `FIRST_JOIN_TIMEOUT_MS=30000`
- `REPLAY_WAIT_MS=30000`
- `REPLAY_BUFFER_MS=5000`
- `DLQ_RETENTION_MS=604800000`
- `DLQ_SWEEP_INTERVAL_MS=3600000`

Important hosted-client notes:

- `CLIENT_BASE_URL` is the actual externally hosted client URL used by `GET /session/:sessionId/join`
- `CLIENT_ORIGIN` is the browser origin allowlist used for CORS and WebSocket origin checks
- if your client and server are hosted separately, both must be set correctly

## Authentication And Security

### Control API authentication

Protected control and admin endpoints require:

```http
Authorization: Bearer <CONTROL_API_TOKEN>
```

Protected endpoints include:

- `POST /session/start`
- `POST /session/:sessionId/replay`
- `POST /session/:sessionId/end`
- all `/admin/*` endpoints

### HMAC signing

If `HMAC_SECRET` is set, the server signs:

- webhook deliveries
- the `POST /session/start` response

Current signing behavior:

- algorithm: `HMAC-SHA256`
- body used for signing: the raw JSON body string
- output format: lowercase hex digest

Webhook/header names:

- `X-Event-Type`
- `X-Event-Id`
- `X-Hub-Signature-256`

Example verification logic:

```js
import crypto from 'node:crypto';

function verifySignature(rawBody, receivedSignature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(String(receivedSignature || ''), 'utf8')
  );
}
```

## Core API

### 1. Start a session

`POST /session/start`

Auth:

- Bearer token required

Purpose:

- create a new Open Box session
- register all players for round 1
- return the server join URL

Request:

```json
{
  "playerCount": 5,
  "stakeAmount": 100,
  "playerIds": [
    "player-1",
    "player-2",
    "player-3",
    "player-4",
    "player-5"
  ]
}
```

Success response:

```json
{
  "sessionId": "e90df0df-e287-4583-b913-259175afb633",
  "joinUrl": "https://your-server.example.com/session/e90df0df-e287-4583-b913-259175afb633/join",
  "playerCount": 5,
  "stakeAmount": 100,
  "status": "WAITING_FOR_FIRST_JOIN",
  "firstJoinTimeoutMs": 30000,
  "devWaitForAllPlayers": false
}
```

Notes:

- the response status is the initial session status snapshot at creation time
- it should come back as `WAITING_FOR_FIRST_JOIN` for a newly created session
- the session may later move to `CANCELLED` if the pre-round inactivity timeout expires before the round starts

Possible errors:

- `400` invalid payload
- `409` player already belongs to another active session

### 2. Mark join intent  HANDLED BY GAME CLIENT

`POST /session/:sessionId/join-intent`

Auth:

- no Bearer token

Purpose:

- tell the server that a specific player actually joined the round
- this is what moves the round toward join window open and ready check

Request:

```json
{
  "playerId": "player-1",
  "playerName": "Alice"
}
```

Possible errors:

- `404` session not found
- `400` invalid player/session state

### 3. Replay a session

`POST /session/:sessionId/replay`

Auth:

- Bearer token required

Purpose:

- start a new round inside the same session

Current replay rules:

- minimum 2 unique players
- all replay `playerIds` must already belong to the session
- replay players are expected to be connected when replay is requested

Request:

```json
{
  "playerIds": [
    "player-1",
    "player-2",
    "player-3",
    "player-4",
    "player-5"
  ]
}

```

Success response:

```json
{
  "sessionId": "e90df0df-e287-4583-b913-259175afb633",
  "roundId": "932dfcd5-d4b3-4d69-bced-ce3705314172",
  "roundNumber": 2,
  "expectedPlayerCountForRound": 5
}
```

### 4. End a session

`POST /session/:sessionId/end`

Auth:

- Bearer token required

Purpose:

- manually end a session when allowed

Current behavior:

- if the round has not started yet (`WAITING_FOR_FIRST_JOIN`, `JOIN_WINDOW_OPEN`, `READY_CHECK`), the server cancels the round first and then ends the session
- if the round is already ongoing (`DISTRIBUTING`, `SWAP_OPEN`, `SWAP_CLOSED`), the request is rejected
- if the round is already `ROUND_CANCELLED`, the session ends without emitting a second `round.cancelled`
- if the round is already `ROUND_ENDED`, the session ends normally and `session.ended.lastRoundStatus` is `ended`

Success response:

```json
{
  "ok": true,
  "sessionId": "e90df0df-e287-4583-b913-259175afb633",
  "sessionStatus": "CANCELLED",
  "roundStatus": "ROUND_CANCELLED"
}
```

Conflict response when the round is ongoing:

```json
{
  "error": "Round is already ongoing",
  "code": "ROUND_ONGOING",
  "sessionStatus": "ROUND_ACTIVE",
  "roundStatus": "SWAP_OPEN"
}
```

### 5. Read public session state

`GET /session/:sessionId`

Auth:

- no Bearer token

Purpose:

- inspect the public session snapshot
- useful for diagnostics and launcher coordination

Returns:

- `session`
- `round`
- `players`
- `boxes`

Reveal fields such as reward amounts are only exposed once the round is in a reveal-complete state.


### 6. Health

`GET /health`

Returns:

```json
{
  "ok": true,
  "activeSessions": 3
}
```

## Admin And Operations Endpoints

### Active sessions

- `GET /admin/sessions/active`
- `POST /admin/sessions/active`

Auth:

- Bearer token required

Returns a summary list of active sessions, including:

- `sessionId`
- `sessionStatus`
- `roundId`
- `roundNumber`
- `roundStatus`
- `playerCount`
- `joinedCount`
- `readyCount`
- `expectedReadyCount`
- `connectedCount`
- `createdAt`
- `endedAt`
- `endReason`

### End an active session

`POST /admin/session/:sessionId/end`

Auth:

- Bearer token required

Response:

```json
{
  "ok": true,
  "sessionId": "e90df0df-e287-4583-b913-259175afb633",
  "sessionStatus": "CANCELLED",
  "roundStatus": "ROUND_CANCELLED"
}
```

### Session debug

`GET /admin/session/:sessionId/debug`

Auth:

- Bearer token required

Returns the internal runtime debug view:

- `snapshotRevision`
- `session`
- `round`
- `players`
- `boxes`
- `swaps`
- recent `events`

## Player Launch And Client Flow


If you host your own client wrapper, pass the game server data into that client.

Typical values:

- `joinUrl`
- `sessionId`
- `playerId`
- `playerName`
- `ws`

Where:

- `joinUrl` is the value returned by `POST /session/start`
- `ws` is the WebSocket origin derived from the Open Box server URL

Player identity rules:

- `playerId` is required
- `playerName` is required
- `playerName` is normalized with trim + whitespace collapse and truncated to 15 characters

Hosted client redirect behavior:

- `GET /session/:sessionId/join` redirects to the configured `CLIENT_BASE_URL`
- the server appends `joinUrl`, `sessionId`, `playerId`, `playerName`, and `ws` as query parameters
- if you do not use the redirect endpoint, your own client launcher should pass those same values directly

### Current round flow

The current server/client lifecycle is:

1. session created
2. players connect
3. players send `join-intent`
4. join window opens
5. once all expected players join, the round enters `READY_CHECK`
6. every player can click `Ready`
7. after `READY_CHECK_TIMEOUT_MS`, remaining unready players are auto-readied
8. server starts `DISTRIBUTING`
9. swap opens
10. swap closes
11. final results are published and the round settles
12. replay window opens
13. replay starts or session ends

Pre-round expiry behavior:

- if the round has not started before `SESSION_INACTIVITY_TIMEOUT_MS` elapses from session creation, the server emits `round.cancelled` and then `session.ended`
- this timeout only applies before the first real round start

Supported player counts:

- `POST /session/start` accepts `playerCount` from `2` to `50`
- replay also supports `2+` connected players that already belong to the session

## Webhook Delivery

Webhooks are sent to every URL in `WEBHOOK_ENDPOINTS`.

Each webhook body contains the same top-level envelope:

- `eventId`
- `eventName`
- `eventVersion`
- `occurredAt`
- `sessionId`
- `roundId`
- `roundNumber`

Headers:

- `X-Event-Type`
- `X-Event-Id`
- `X-Hub-Signature-256`

## Webhook Event Reference

### `session.created`

Fires after `POST /session/start` succeeds.

Use it to:

- record a new Open Box session in your system
- store initial player membership
- store session economy values

Important fields:

- `status`
- `registeredPlayerCountForSession`
- `stakeAmount`
- `totalStakeAmount`
- `platformFee`
- `rewardPool`
- `registeredPlayerIds`
- `players`
- `roundCount`
- `currentRoundId`

### `player.joined`

Fires when a player successfully joins the current round.

Use it to:

- update queue occupancy
- update player presence
- decide when your own launcher should move from pending to joining state

Important fields:

- `player`
- `registeredPlayerCountForSession`
- `expectedPlayerCountForRound`
- `joinedPlayerCountForRound`
- `remainingPlayersToStart`
- `reason`

### `player.disconnected`

Fires when a connected player drops or times out.

Important fields:

- `player`
- `connectedPlayerCountForRound`
- `reason`

### `player.reconnected`

Fires when a disconnected player reconnects.

Important fields:

- `player`
- `connectedPlayerCountForRound`
- `reason`

### `round.join_window_started`

Fires when the join window opens for a round.

Important fields:

- `reason`
- `joinDeadlineAt`
- `registeredPlayerCountForSession`
- `expectedPlayerCountForRound`
- `joinedPlayerCountForRound`
- `player`

### `round.started`

Fires when a round actually enters distribution.

Important fields:

- `reason`
- `status`
- `registeredPlayerCountForSession`
- `expectedPlayerCountForRound`
- `joinedPlayerCountForRound`
- `connectedPlayerCountAtRoundStart`
- `stakeAmount`
- `totalStakeAmount`
- `platformFee`
- `rewardPool`
- `distributionStartedAt`
- `distributionEndsAt`
- `players`
- `boxes`

### `round.swap_matched`

Fires when two players are matched in the swap phase.

Important fields:

- `matchedAt`
- `firstPlayer`
- `secondPlayer`
- `firstBoxBefore`
- `secondBoxBefore`
- `firstBoxAfter`
- `secondBoxAfter`
- `swapMatch`

### `round.ended`

Fires when the round is fully settled.

Important:

- this happens before final session end
- this is the correct event for round settlement, winner/loser processing, and final results persistence
- this is not the same thing as `session.ended`

Important fields:

- `status`
- `endReason`
- round timing fields
- `stakeAmount`
- `totalStakeAmount`
- `platformFee`
- `rewardPool`
- `players`
- `boxes`
- `swapMatches`
- `winners`
- `losers`

Winner/loser behavior:

- `winners` are players whose final owned box has a payout above `0`
- `losers` are players whose final owned box payout is `0` or below

### `round.cancelled`

Fires when the round cannot continue before it starts.

Current cases include:

- joined players stayed below minimum
- pre-round inactivity timeout expired before round start

Important fields:

- `status`
- `endReason`
- `minimumPlayersRequired`
- `players`
- `winners`  (always `[]`)
- `losers`   (always `[]`)

Notes:

- `round.cancelled` does not include `boxes`
- `round.cancelled` does not include `swapMatches`

### `session.replay_waiting`

Fires after a round ends and the replay window opens.

Important fields:

- `status`
- `registeredPlayerCountForSession`
- `expectedPlayerCountForRound`
- `joinedPlayerCountForRound`
- `replayWaitMs`
- `replayBufferMs`
- `replayPlayerIds`

### `session.replay_started`

Fires when replay starts successfully.

Important fields:

- `status`
- `replayPlayerIds`
- new `roundId`
- new `roundNumber`

### `session.ended`

Fires only when the full session is actually over.

Important:

- this is the terminal cleanup event
- do not use this in place of `round.ended` for round settlement

Important fields:

- `status`
- `endReason`
- `roundCount`
- `lastRoundId`
- `lastRoundNumber`
- `lastRoundStatus`
- `stakeAmount`
- `totalStakeAmount`
- `platformFee`
- `endedAt`

`lastRoundStatus` values currently used:

- `cancelled`
- `ended`

## Economy Fields

Important round/session payloads expose:

- `stakeAmount`
- `totalStakeAmount`
- `platformFee`
- `rewardPool`

`platformFee` contains:

- `type`
- `configuredValue`
- `effectivePercentage`
- `feeAmount`

If fee mode is fixed, `effectivePercentage` is still computed from the actual total stake.

## DLQ

Failed webhook deliveries are stored on disk in the server DLQ directory.

Current behavior:

- permanent `4xx` webhook failures can be persisted to DLQ
- exhausted retry attempts can be persisted to DLQ
- expired DLQ items are purged automatically according to `DLQ_RETENTION_MS`
- periodic DLQ cleanup runs according to `DLQ_SWEEP_INTERVAL_MS`

Each DLQ item contains:

- `dlqItemId`
- `failedAt`
- `endpoint`
- `eventId`
- `eventName`
- `reason`
- `lastResponseStatus`
- `deliveryAttempts`
- `webhookPayload`

## DLQ Endpoints

### List DLQ items

`GET /admin/dlq`

Response:

```json
{
  "items": [
    {
      "dlqItemId": "0603ffa7-80c1-430d-8fe1-1231283798f1",
      "failedAt": "2026-03-27T12:00:00.000Z",
      "endpoint": "https://example.com/webhooks/open-box",
      "eventId": "0eebbc4c-6490-402b-97ab-ca8710fbed98",
      "eventName": "round.ended",
      "reason": "Exhausted 3 retry attempts.",
      "lastResponseStatus": 500,
      "deliveryAttempts": 3
    }
  ]
}
```

### Read one DLQ item

`GET /admin/dlq/:id`

Returns the full stored DLQ record, including `webhookPayload`.

### Resend one DLQ item

`POST /admin/dlq/:id/resend`

Success response:

```json
{
  "ok": true,
  "dlqItemId": "0603ffa7-80c1-430d-8fe1-1231283798f1",
  "eventId": "0eebbc4c-6490-402b-97ab-ca8710fbed98",
  "eventName": "round.ended",
  "endpoint": "https://example.com/webhooks/open-box"
}
```

Failure response:

```json
{
  "ok": false,
  "dlqItemId": "0603ffa7-80c1-430d-8fe1-1231283798f1",
  "eventId": "0eebbc4c-6490-402b-97ab-ca8710fbed98",
  "eventName": "round.ended",
  "endpoint": "https://example.com/webhooks/open-box",
  "error": "Failed to resend DLQ item",
  "attempts": 3,
  "status": 500
}
```

### Clear the DLQ

`DELETE /admin/dlq`

Response:

```json
{
  "ok": true,
  "clearedCount": 4
}
```

## Building Your Own Matchmaking Server

If you want to build your own queue/matchmaking layer on top of Open Box, use this model.

### Recommended lifecycle

1. Collect players in your own queue.
2. When the room is full, call `POST /session/start`.
3. Store:
   - `sessionId`
   - `joinUrl`
   - stake
   - player ids
4. Launch each player using either:
   - the server join page
   - or your own hosted client URL
5. Have each client call `POST /session/:sessionId/join-intent`.
6. Track progress with:
   - `player.joined`
   - `round.join_window_started`
   - `round.started`
7. After settlement, use:
   - `round.ended`
   - `session.replay_waiting`
8. If you support replay, decide eligible players in your own system and call:
   - `POST /session/:sessionId/replay`
9. When you receive `session.ended`, clear the room from your matchmaking system.

Matchmaking callback note:

- `MATCHMAKING_SERVICE_URL` is optional
- if it is empty, the dedicated matchmaking callback is skipped
- normal webhook delivery through `WEBHOOK_ENDPOINTS` is unaffected

If you use the server join page:

- launch the player with `GET /session/:sessionId/join?playerId=...&playerName=...`
- the server will redirect the player to `CLIENT_BASE_URL` with the required launch query

### Recommended webhook usage

Use these events in your external orchestration layer:

- `session.created`
  create your local room/session record
- `player.joined`
  track fill and join progress
- `round.started`
  mark the room as live
- `round.ended`
  persist winners, losers, prizes, and swap outcomes
- `session.replay_waiting`
  open your replay decision window
- `session.replay_started`
  keep the same session alive and reset replay votes
- `session.ended`
  perform final cleanup

### Important design rule

Use:

- `round.ended` for round result settlement
- `session.ended` for final session cleanup

Do not wait for `session.ended` if your business logic needs the completed round result payload. That data is already available in `round.ended`.
