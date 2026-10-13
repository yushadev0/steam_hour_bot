# yusha's Steam Hour Bot

Headless Steam hour booster for Windows and Linux. Signs in to your Steam account and shows the games you pick (by AppID) as "in-game" so playtime accumulates — no game install required.

> **Status:** early development (Phase 0 done — proof of concept). See [PLAN.md](PLAN.md) for the roadmap.

## Planned features

- Multiple accounts, each with its own game list (up to 32 games at once)
- Web panel (React + Vite) with live status
- Steam Guard support (email / mobile code / mobile approval), refresh-token login — passwords are never stored
- Online / Invisible mode
- Card farming mode
- Docker image and standalone Windows `.exe`

## Proof of concept

Requires Node.js 22+.

```bash
npm install
npm run spike -- 730            # show CS2 as playing
npm run spike -- 730 --invisible
npm run smoke                   # anonymous Steam connection test
```

The refresh token is saved to `data/` (git-ignored) so the next run won't ask for your password.

## Disclaimer

Idling games may be against the Steam Subscriber Agreement. Use at your own risk.
