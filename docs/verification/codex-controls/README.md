# Codex controls verification — 0.4.18 (46)

Validated on 2026-10-04 against Codex app-server 0.160.0 through the deployed HTTPS gateway 0.2.0. Tests used dedicated threads.

- 335 client tests; 19 gateway tests; TypeScript and version checks passed.
- Native checks: saved effort, permission profiles and collaboration modes; real token usage; context compaction; restored usage after a new RPC connection.
- Android API 35 / Gboard: loaded existing history, continued a conversation, created a new session, changed effort high/max/low, read-only/workspace permissions, approval policy, plan/default mode and model.
- After selecting a model, the next prompt inherited that model and its saved effort. Slash commands opened controls without being sent as prompts.
- Android-triggered compaction produced a native completion item. The button returned to its idle state without reloading the screen. Reopening the app preserved settings and context usage.
- Five keyboard open/close cycles with a multiline draft: controls stayed above Gboard and returned to their initial position.
- Both release APKs passed package/version, non-debuggable, signing-certificate, architecture and 16 KiB ZIP-alignment checks. The ARM64 phone and x86_64 emulator APKs contain the same JavaScript bundle.

The JSON files contain assertions and artifact hashes. Android screenshots are kept with the local delivery evidence.

## Repeat

Run `npm test`, `npm run typecheck`, `npm run check:versions`, and `npm test --prefix server/codex`. The native check is opt-in and creates a test thread:

```sh
CODEX_CONTROLS_REPORT=/path/to/report.json node server/codex/live-controls-check.mjs
```

With the release installed in an emulator, set `CODEX_GATEWAY_URL`, `CODEX_GATEWAY_USERNAME`, and `CODEX_GATEWAY_PASSWORD_FILE`. Run `scripts/android-cua-smoke.py --scenarios codex_direct --include-xml` to establish an authenticated connection, then set `CODEX_CONTROLS_SESSION` to the dedicated native test thread and run `scripts/check-codex-controls.py --output-dir /path/to/evidence`.

Context after compaction is a server estimate. Cached input and reasoning output are included in the native input/output totals. Account limits, plan events and diffs depend on what the daemon provides. Client-owned dynamic tools and login requests remain with the original Codex client; archive, rollback and delete controls are outside this release.
