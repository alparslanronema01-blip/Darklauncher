# Darklauncher 🌑

[![Tests](https://github.com/darklauncher/darklauncher/actions/workflows/test.yml/badge.svg)](https://github.com/darklauncher/darklauncher/actions/workflows/test.yml)
[![Release](https://github.com/darklauncher/darklauncher/actions/workflows/release.yml/badge.svg)](https://github.com/darklauncher/darklauncher/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cf6.svg)](LICENSE)

Dark-themed Minecraft launcher built with Electron. Real launcher logic — no wrappers, no bloat, zero runtime dependencies beyond Electron itself.

## Features

- **Version browser** — every Mojang release & snapshot, searchable, with installed markers and release dates
- **One-click launch** — auto-downloads client jar, libraries, natives and assets (sha1-verified, 16-way parallel asset downloads with retry + backoff)
- **Fabric mod loader** — one-click Fabric installation for any Minecraft version; the modded instance appears in the version list and launches like a native version
- **Modrinth browser** — search mods, one-click install with automatic required-dependency resolution, sha1 verification, per-instance mod management
- **Server manager** — save servers and join them directly from the play button (`--server/--port`)
- **Version manager** — installed versions with disk usage, last-played stats and one-click deletion
- **Automatic Java** — scans system installs; if nothing suitable is found it downloads the official Mojang runtime matching the version's required Java (8/11/17/21)
- **Offline accounts** — pick any username and play (offline uuid generation like vanilla servers expect)
- **Microsoft login** — device-code OAuth flow, Xbox Live → XSTS → Minecraft services chain, token refresh
- **Multi-account** — saved account list, one-click switching, sign out
- **Game control** — stop the running game, open the game folder, live console output
- **Smart memory clamp** — RAM slider capped at 75% of real system memory so the JVM never asks for more than the machine has
- **Frameless dark UI** — custom titlebar, purple/cyan accent theme, offline-safe avatar fallback, toast notifications, color-coded console
- **System tray** — close button can minimize to tray (optional), tray menu with show/quit
- **Professional logging** — leveled, timestamped logs written to `appdata/logs/` with automatic rotation and secret masking (JWTs/tokens never touch disk or console)
- **Resilient persistence** — atomic JSON writes (tmp + fsync + rename), corrupt-file quarantine to `.bak`, settings survive upgrades via deep-merge
- **Smart networking** — manifest revalidation via ETag/304, Retry-After-aware retries with jittered backoff, hard timeouts, classified transient errors
- **Window memory** — size/position restored between sessions (clamped to the work area)
- **Play history** — last played time and total minutes tracked per version
- **Single instance** — launching the app twice focuses the existing window

## Getting started

```bash
npm install
npm start
```

No Java needed up front — Darklauncher auto-downloads the official Mojang runtime when no local Java matches the selected version. You can also set a custom path in Settings.

### Run it as a Windows app (double-click)

Double-click **`Darklauncher.bat`** — that's it. It checks for Node.js, installs dependencies automatically on first run, then starts the launcher with **no console window** left open.

- `Darklauncher.bat shortcut` — creates a **Darklauncher** shortcut on your desktop (uses `build/icon.ico`)
- `Darklauncher.bat debug` — runs via `npm start` so Electron logs stay visible for troubleshooting

**No Electron? See the UI instantly:** `npm run preview` regenerates `preview/index.html` from the real renderer files with a mocked API, so the whole interface can be reviewed in any browser without installing Electron.

## Building an installer

```bash
npm run icons   # regenerates build/icon.png + build/icon.ico (artwork logo: scripts/process-logo.js)
npm run dist
```

Produces a Windows NSIS installer **and** a portable zip in `dist/` (electron-builder).

### Releases (maintainers)

Push a tag and CI does the rest — tests, build, draft GitHub Release with the installer + zip attached:

```bash
git tag v1.0.1
git push origin v1.0.1
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full flow and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## Project layout

```
src/
  main.js        Electron main process + IPC (tray, window persistence, lifecycle)
  preload.js     contextBridge API exposed to the renderer
  store.js       atomic JSON persistence, corrupt recovery, play history
  versions.js    Mojang manifest (TTL + ETag revalidation + offline fallback)
  launcher.js    download engine, natives extraction, launch args, process-tree kill
  fabric.js      Fabric loader installation (profile generation + maven libraries)
  modrinth.js    Modrinth search, version resolution, dependency-aware mod install
  instances.js   saved servers, installed-version stats, safe version deletion
  java.js        system Java scan + Mojang runtime auto-download
  auth.js        Microsoft device-code flow, proactive token refresh, offline accounts
  util.js        HTTP layer: timeouts, retries with jitter, parallel pool, formatters
  logger.js      leveled file logging, rotation, ring buffer, secret masking
  renderer/      index.html, style.css, renderer.js (the UI)
Darklauncher.bat    double-click starter (auto-installs deps, silent launch, shortcut mode)
scripts/
  launch-silent.vbs   windowless starter used by Darklauncher.bat
  gen-icons.js   zero-dependency PNG/ICO icon generator
  build-preview.js  generates preview/index.html from the real renderer files + mock API
test/
  smoke.test.js  56 core-logic tests (rules, natives zip parsing, classpath, args,
                 secret masking, retry classification, atomic persistence, history,
                 fabric paths, server management, mod path-safety)
preview/
  index.html     browser-runnable UI preview with a mocked API
```

## How launching works

1. Version JSON is fetched from Mojang's manifest (cached in `versions/<id>/`; corrupt downloads are cleaned up automatically).
2. `inheritsFrom` versions (modded-style) are merged with their parent.
3. Libraries + client jar download in parallel with sha1 verification; natives jars are unpacked with a built-in ZIP parser (no external deps). Legacy manifest entries without `downloads` metadata are resolved from their maven `url`.
4. Asset index + objects download concurrently; `virtual`/`map_to_resources` legacy layouts are supported. A few failed sound/texture files won't block the game.
5. Java is resolved: custom path → system scan → official Mojang runtime download.
6. JVM + game arguments are built from the version manifest templates, memory is clamped to the machine, fullscreen/resolution applied, and the game spawns detached with output piped to the Console tab. Stopping the game kills the entire process tree.

## Diagnostics

Every backend action is logged with scope and level to `appdata/logs/darklauncher.log` (auto-rotates at 5 MB, keeps one `.old`). Secrets — Minecraft access tokens, Microsoft refresh tokens, Xbox JWTs — are masked before anything is written. The About page shows version info, the data folder, and a button to open the log folder directly.

## Notes

- Data lives in `appdata/` next to the app in dev (`versions/`, `assets/`, `libraries/`, `runtimes/`, `game/`, settings & auth JSON). In packaged builds it moves to the OS user-data directory.
- `npm test` runs the core-logic smoke tests without needing Electron or a network connection.
- The UI preview in `preview/index.html` is generated (`npm run preview`) from the real renderer HTML/CSS/JS with a mocked `window.darklauncher` API — design review only, launch logic runs in the real app.
