# Authorization Matrix (HTTP + Socket.IO)

This document describes **who can call what** in the current backend implementation.

## Access Token Usage

- HTTP protected routes use `Authorization: Bearer <access_token>`.
- Socket.IO requires a valid access token at handshake:
  - `auth.accessToken` (preferred)
  - `auth.token` (legacy fallback)
  - or `Authorization: Bearer <access_token>` header

If token is missing/invalid:
- HTTP: `401`
- Socket connect: connection rejected (`MISSING_ACCESS_TOKEN` / `INVALID_ACCESS_TOKEN`)

---

## HTTP Endpoint Matrix

### Gameplay / Realtime-related endpoints

| Method | Endpoint | Auth Required | Who can call | Common auth/access failures |
|---|---|---|---|---|
| POST | `/games` | Yes | Any authenticated user (game creator is forced from token `req.auth.id`) | `401` |
| GET | `/invite/:inviteToken` | Yes | Any authenticated user with valid invite token | `401` |
| PATCH | `/games/:gameId/start` | Yes | Authenticated user who has access to that game (creator or joined team member) | `401`, `403 GAME_ACCESS_DENIED` |
| PATCH | `/games/:gameId/finish` | Yes | Authenticated user who has access to that game (creator or joined team member) | `401`, `403 GAME_ACCESS_DENIED` |
| PATCH | `/games/offers/draw` | Yes | Authenticated user for their own `team_member_id` slot | `401`, `403 TEAM_MEMBER_ACCESS_DENIED` |
| PATCH | `/games/offers/forfeit` | Yes | Authenticated user for their own `team_member_id` slot | `401`, `403 TEAM_MEMBER_ACCESS_DENIED` |
| PATCH | `/team-members/:teamMemberId/join` | Yes | Authenticated user joining an available slot (subject to active game rules) | `401`, `409` conflicts |
| PATCH | `/team-members/:teamMemberId/bot` | Yes | Authenticated user with access to target game (can assign bot slot) | `401`, `403 GAME_ACCESS_DENIED` |
| GET | `/bots/names` | Yes | Any authenticated user | `401` |
| POST | `/moves` | Yes | Authenticated user moving **their own** `team_member_id` slot | `401`, `403 TEAM_MEMBER_ACCESS_DENIED` |
| POST | `/bot/moves` | Yes | Authenticated user who is a joined **human teammate** of that bot slot | `401`, `403 BOT_CONTROL_ACCESS_DENIED` |
| GET | `/games/:gameId/moves` | Yes | Authenticated user with access to that game | `401`, `403 GAME_ACCESS_DENIED` |
| POST | `/game-chats` | Yes | Authenticated user posting as **their own** `team_member_id` slot | `401`, `403 TEAM_MEMBER_ACCESS_DENIED` |
| GET | `/team-members/:teamMemberId/reserves` | Yes | Authenticated user with access to that team member’s game | `401`, `403 GAME_ACCESS_DENIED` |

### Auth/account endpoints

| Method | Endpoint | Auth Required | Notes |
|---|---|---|---|
| POST | `/users` | No | Register user |
| GET | `/users/:userId` | No | Current implementation is public |
| PATCH | `/users/:userId` | No | Current implementation is public |
| DELETE | `/users/:userId` | No | Current implementation is public |
| POST | `/sessions` | No | Login |
| POST | `/sessions/refresh` | No | Refresh flow |
| DELETE | `/sessions` | No | Logout flow |
| GET | `/email-verifications/:token` | No | Email verification |

> Note: account/user endpoints above are listed as implemented today. If needed, these can be tightened further.

---

## Socket.IO Matrix

## Connect / Handshake

| Event | Auth Required | Rule |
|---|---|---|
| Socket connect | Yes | Must provide valid access token in handshake |

## Client -> Server events

| Event | Auth Required | Who can call | Common failures |
|---|---|---|---|
| `lobby:join` | Yes | Any authenticated socket | `lobby:error` on internal failures |
| `lobby:sync` | Yes | Any authenticated socket | `lobby:error` on internal failures |
| `lobby:leave` | Yes | Any authenticated socket | - |
| `game:join` | Yes | Authenticated socket with access to target game | `game:error` with `INVALID_GAME_ID`, `GAME_ACCESS_DENIED`, `GAME_NOT_FOUND` |
| `game:sync` | Yes | Authenticated socket with access to target game | `game:error` with `INVALID_GAME_ID`, `GAME_ACCESS_DENIED`, `GAME_NOT_FOUND` |
| `game:leave` | Yes | Any authenticated socket (with valid game id) | `game:error` with `INVALID_GAME_ID` |
| `ping` | Yes | Any authenticated socket | - |

## Server -> Client realtime events

### Lobby scope
- `lobby:joined`
- `lobby:left`
- `lobby:snapshot`
- `lobby:game-created`
- `lobby:game-updated`
- `lobby:error`

### Game scope (`game:{gameId}` room)
- `game:joined`
- `game:left`
- `game:snapshot`
- `game:move-created`
- `game:reserve-updated`
- `game:chat-created`
- `game:status-updated`
- `game:team-member-updated`
- `game:offer-updated`
- `game:error`

---

## Frontend Integration Checklist

1. Log in via `/sessions` and store access token.
2. Attach bearer token on all protected HTTP calls.
3. Open Socket.IO with `auth: { accessToken }`.
4. Call `lobby:join` and consume `lobby:snapshot` first.
5. Call `game:join` for selected game and consume `game:snapshot` first.
6. After snapshot, apply realtime delta events (`game:move-created`, `game:chat-created`, etc.).

This order prevents state drift after reconnects.
