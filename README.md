# yusha's Steam Hour Bot

Headless Steam hour booster for Windows and Linux. Signs in to your Steam account and shows the games you pick (by AppID) as "in-game" so playtime accumulates — no game install required.

> **Status:** web panel, API and core engine are ready (Phase 3). Card farming and Docker are next. See [PLAN.md](PLAN.md).

## Planned features

- Multiple accounts, each with its own game list (up to 32 games at once)
- Web panel (React + Vite) with live status
- Steam Guard support (email / mobile code / mobile approval), refresh-token login — passwords are never stored
- Online / Invisible mode
- Card farming mode
- Docker image and standalone Windows `.exe`

## Usage

Requires Node.js 22+ (or use the standalone binary).

```bash
npm install
npm run build:web  # build the web panel once
npm start          # bot + panel on http://127.0.0.1:8090
```

On first start a random panel password is printed once in the log (set `SHB_ADMIN_PASSWORD` to choose your own). See [docs/API.md](docs/API.md) for the REST/WebSocket API.

### CLI

Account management also works from the command line while the server is stopped:

```bash
npm run cli -- add <username>          # sign in (password + Steam Guard asked once)
npm run cli -- games <username> 730 440
npm run cli -- persona <username> invisible
npm run cli -- list
npm run smoke                          # anonymous Steam connection test
```

The standalone binary takes the same commands (`steam-hour-bot add <username>`). Run it without arguments to start the server.

### Configuration

| Variable | Default | |
|---|---|---|
| `SHB_DATA_DIR` | `./data` | Accounts, encrypted tokens, panel auth |
| `SHB_HOST` | `127.0.0.1` | Use `0.0.0.0` to expose (e.g. Docker) |
| `SHB_PORT` | `8090` | |
| `SHB_ADMIN_PASSWORD` | random | Panel password |
| `SHB_SECRET` | `data/secret.key` | Token encryption key |
| `SHB_TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |

Refresh tokens are encrypted with AES-256-GCM. Passwords are never stored.

The bot backs off automatically when you start a game on the same account elsewhere, and resumes when you're done.

## Building a standalone binary

Requires [Bun](https://bun.sh).

```bash
npm run build:exe                                        # current platform (panel embedded)
cd apps/server && bun scripts/build-exe.ts bun-linux-x64 # cross-compile
```

## Development

```bash
npm run demo       # server with fake Steam accounts (panel password: demo)
npm run dev:web    # Vite dev server with hot reload, proxies /api to :8090
npm test
npm run typecheck
```

## Disclaimer

Idling games may be against the Steam Subscriber Agreement. Use at your own risk.
