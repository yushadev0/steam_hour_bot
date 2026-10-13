# yusha's Steam Hour Bot

Headless Steam hour booster for Windows and Linux. Signs in to your Steam account and shows the games you pick (by AppID) as "in-game" so playtime accumulates — no game install required.

> **Status:** usable — web panel, API, card farming, Docker and standalone binaries are ready. See [PLAN.md](PLAN.md).

## Planned features

- Multiple accounts, each with its own game list (up to 32 games at once)
- Web panel (React + Vite) with live status
- Steam Guard support (email / mobile code / mobile approval), refresh-token login — passwords are never stored
- Online / Invisible mode
- Card farming mode: reads your badges page, idles games with card drops left one at a time, then returns to your game list
- Docker image and standalone Windows `.exe`

## Usage

Requires Node.js 22+ (or use the standalone binary).

```bash
npm install
npm run build:web  # build the web panel once
npm start          # bot + panel on http://127.0.0.1:8090
```

The panel is a local UI: it only listens on `127.0.0.1` and needs no password. On Windows the standalone exe opens it in your browser automatically. On a headless Linux box, open it from that machine (or through an SSH tunnel: `ssh -L 8090:127.0.0.1:8090 server`). See [docs/API.md](docs/API.md) for the REST/WebSocket API.

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
| `SHB_PORT` | `8090` | |
| `SHB_SECRET` | `data/secret.key` | Token encryption key |
| `SHB_NO_BROWSER` | | Set to stop the Windows exe from opening the panel |

Refresh tokens are encrypted with AES-256-GCM. Passwords are never stored.

The bot backs off automatically when you start a game on the same account elsewhere, and resumes when you're done.

## Running on a Linux server (Docker)

```bash
git clone https://github.com/yushadev0/steam_hour_bot && cd steam_hour_bot
mkdir -p data
printf 'SHB_UID=%s
SHB_GID=%s
' "$(id -u)" "$(id -g)" > .env   # data/ stays owned by you
docker compose up -d --build
docker compose logs -f
```

The container uses host networking so the bot listens on the server's own `127.0.0.1:8090`; no port is exposed to the internet. Open the panel through an SSH tunnel from your computer:

```bash
ssh -L 8090:127.0.0.1:8090 user@server   # then browse http://127.0.0.1:8090
```

To update: `git pull && docker compose up -d --build`. From a development machine, `npm run deploy` does the same over SSH (set `DEPLOY_TARGET=user@server` and optionally `DEPLOY_KEY` in a local `.env`).

Without Docker, use the Linux binary with the systemd user service in [deploy/steam-hour-bot.service](deploy/steam-hour-bot.service).

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
