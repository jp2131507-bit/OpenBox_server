# `game` Upgrade Plan

## Stage 1: Runtime and Client Bootstrap
- Replace the basic `game` server flow with an authoritative session and round runtime modeled on `old.open-box` and `old.open-box/docs/implementation.md`.
- Require `playerId` and `playerName` for every match launch and stop creating anonymous players on WebSocket `hello`.
- Add session start, join-intent, round bootstrap, replay-ready state, swap queue handling, and session persistence with Redis in production and memory fallback for local work.
- Keep the existing client UI and WebSocket message names where possible so the front end can continue to work with minimal UI changes.
- Lower the supported minimum player count from 5 to 2 while keeping the old prize logic:
  - 2 players: 1 winning box
  - 3 players: 1 winning box
  - 4 players: 2 winning boxes with a 60/40 split
  - 5+ players: same behavior as `old.open-box`
- Keep `/api/sessions` only as a temporary adapter until the full old-compatible contract is verified.

## Stage 2: Exact HTTP Contract, Replay, and Webhooks
- Implement the old-compatible public contract:
  - `POST /session/start`
  - `POST /session/:sessionId/join-intent`
  - `POST /session/:sessionId/replay`
  - `POST /session/:sessionId/end`
  - `GET /session/:sessionId`
  - `GET /session/:sessionId/join`
  - `GET /health`
- Add admin routes and DLQ routes matching `old.open-box`.
- Make `GET /session/:sessionId/join` redirect to the separately hosted client URL from `CLIENT_BASE_URL`, while still keeping local static serving for development.
- Add normalized webhooks with retry, HMAC signing, disk DLQ support, resend and clear operations, and the matchmaking close callback.
- Implement the replay lifecycle so a finished round moves to replay waiting, accepts a replay request for connected registered players, starts a new round, or ends on timeout.
- Keep public reveal data hidden until the round has fully settled.

## Stage 3: Security and Proper Fixes
- Enforce CORS allowlists, WebSocket origin checks, strict request validation, UUID validation on admin and DLQ routes, and required player identity at launch.
- Add active-session locking so a player cannot participate in two active sessions at once.
- Validate environment configuration at startup and align `game` configuration names with `old.open-box`, keeping temporary aliases only where needed.
- Harden reconnect handling, heartbeat timeouts, timer resume after restart, cleanup of ended sessions, late joins, and no-store handling for client assets.
- Remove or formally deprecate the temporary `/api/sessions` adapter after host integrations are confirmed against the old contract.

## Verification Targets
- Contract tests for session start, join-intent, replay, end, health, admin, DLQ, auth failures, and signed responses.
- Domain tests for 2-, 3-, 4-, 5-, and higher-player reward outcomes.
- Runtime tests for join window, ready check, cancellation below minimum, swap matching, softlock, result release, reconnect replay, and replay timeout.
- Client bootstrap checks for required identity fields and external `CLIENT_BASE_URL` redirects.
- Webhook tests for normalized payloads, retries, HMAC, DLQ persistence, resend, and clear.
