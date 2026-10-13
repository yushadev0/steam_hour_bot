# API

Base URL: `http://<host>:8090/api`. All bodies are JSON. Errors are returned as `{ "error": "message" }` with a matching HTTP status.

## Access

The panel and API are meant to be used from the machine the bot runs on. The server listens on `127.0.0.1` only.

| Caller | How it is authorized |
|---|---|
| Local (panel) | No password. Request must come from loopback with a local `Host` header (`localhost`, `127.0.0.1`); an `Origin` header, if present, must match the host. This blocks other websites from driving the panel through your browser. |
| External client (yassistant module) | `Authorization: Bearer shb_...` (or `?token=` on `/ws`). Tokens are created in the panel settings. |

Token management is only allowed locally.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | Always public. `{ ok, name, version }` |
| GET | `/auth/me` | | `{ authKind: "local" \| "token" }` |
| GET | `/tokens` | | Local only |
| POST | `/tokens` | `{ name }` | Local only. Returns `{ token, info }`. The token is shown only once |
| DELETE | `/tokens/:id` | | Local only |

## Accounts

`:id` is the lowercase Steam username.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/accounts` | | `AccountStatus[]` |
| POST | `/accounts` | `{ accountName, password }` | See login flow below |
| GET | `/accounts/:id` | | |
| PATCH | `/accounts/:id` | `{ games?, persona?, mode?, enabled? }` | Applied live |
| DELETE | `/accounts/:id` | | Logs off and deletes the stored token |
| POST | `/accounts/:id/login` | `{ password }` | Re-login when `session.state` is `needs_login` |
| POST | `/accounts/:id/guard` | `{ code }` | Steam Guard code |
| POST | `/accounts/:id/guard/wait` | | Wait for mobile-app approval |
| GET | `/accounts/:id/games` | `?refresh=true` | Owned games sorted by playtime (cached for 10 min) |

- `games`: up to 32 AppIDs
- `persona`: `online` or `invisible`
- `mode`: `games` or `cards` (card farming is planned for phase 4)

### Login flow

`POST /accounts`, `/login` and `/guard` return once login completes, Steam Guard is requested, or 30 s pass:

1. `session.state === "running"`: done.
2. `session.state === "awaiting_guard"`: send the code to `/guard`. `session.guard.type` is `email` or `mobile`. If `guard.lastCodeWrong` is true, ask for the code again. For mobile approval, call `/guard/wait`.
3. HTTP 400: Steam rejected the login. A newly added account is removed in this case.

### AccountStatus

```jsonc
{
  "id": "myuser",
  "accountName": "MyUser",
  "steamId": "7656119...",
  "personaName": "yusha",
  "games": [730, 440],
  "persona": "online",
  "mode": "games",
  "enabled": true,
  "hasToken": true,
  "createdAt": "2026-10-13T10:00:00.000Z",
  "session": {
    "state": "running",        // stopped | connecting | awaiting_guard | running | blocked | waiting_retry | needs_login
    "guard": null,             // { type, domain, lastCodeWrong } while awaiting_guard
    "lastError": null,
    "retryAt": null,           // ISO time of next retry while waiting_retry
    "blockedByApp": null       // AppID being played elsewhere while blocked
  }
}
```

## Logs

`GET /logs?scope=<accountId|core|api>&limit=200`

## WebSocket

`GET /ws` (upgrade). Server → client messages:

| `type` | Payload | When |
|---|---|---|
| `snapshot` | `{ accounts, logs }` | Immediately after connecting |
| `account` | `{ account }` | An account or its session changed |
| `removed` | `{ id }` | An account was deleted |
| `log` | `{ entry }` | New log line |
