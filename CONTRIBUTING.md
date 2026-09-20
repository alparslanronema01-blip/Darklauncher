## Before you start

- Run `npm test` and make sure all smoke tests pass.
- Keep changes focused; one feature or fix per PR.
- **Zero runtime dependencies policy:** do not add runtime deps unless absolutely necessary (dev deps are fine). Even natives ZIP parsing is hand-rolled here — keep it that way.

## Dev quickstart

```bash
npm install
npm start        # run the app
npm test         # core-logic smoke tests (no Electron needed)
npm run preview  # browser preview of the UI with a mocked API
npm run icons    # regenerate default icons (logo: scripts/process-logo.js)
```

## Code layout

See the README "Project layout" section. Renderer changes: after editing
`src/renderer/*`, run `npm run preview` and open `preview/index.html` in a
browser to sanity-check the UI without Electron.

## Commit & PR style

- Conventional-ish prefixes: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`.
- PRs must keep the CI (`.github/workflows/test.yml`) green on both OSes.

## Releases (maintainers)

1. Bump `version` in `package.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the release workflow builds
   the NSIS installer + portable zip and opens a **draft** release.
3. Review the draft, publish.
