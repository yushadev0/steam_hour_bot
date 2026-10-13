# yusha's Steam Hour Bot

Headless Steam hour booster for Windows and Linux. Signs in to your Steam account and shows the games you pick (by AppID) as "in-game" so playtime accumulates — no game install required.

> **Status:** early development — core engine and CLI are ready (Phase 1). See [PLAN.md](PLAN.md) for the roadmap.

## Planned features

- Multiple accounts, each with its own game list (up to 32 games at once)
- Web panel (React + Vite) with live status
- Steam Guard support (email / mobile code / mobile approval), refresh-token login — passwords are never stored
- Online / Invisible mode
- Card farming mode
- Docker image and standalone Windows `.exe`

## Usage (CLI)

Requires Node.js 22+ (or use the standalone binary).

```bash
npm install
npm run cli -- add <username>          # sign in (password + Steam Guard asked once)
npm run cli -- games <username> 730 440
npm run cli -- persona <username> invisible
npm run cli -- list
npm start                              # run all enabled accounts
npm run smoke                          # anonymous Steam connection test
```

Data is stored in `data/` (override with `SHB_DATA_DIR`). Refresh tokens are encrypted with AES-256-GCM using `SHB_SECRET`, or an auto-generated `data/secret.key`. Passwords are never stored.

The bot backs off automatically when you start a game on the same account elsewhere, and resumes when you're done.

## Building a standalone binary

Requires [Bun](https://bun.sh).

```bash
npm run build:exe                                        # current platform
cd apps/server && bun scripts/build-exe.ts bun-linux-x64 # cross-compile
```

## Development

```bash
npm test
npm run typecheck
```

## Disclaimer

Idling games may be against the Steam Subscriber Agreement. Use at your own risk.
