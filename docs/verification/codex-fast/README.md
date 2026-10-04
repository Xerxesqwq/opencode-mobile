# Codex Fast mode — 0.4.21 (49)

Gateway 0.5.0 and Codex app-server 0.160.0. Inference used gpt-6-luna only.

- Native HTTP checks enabled catalog tier `priority` and cleared it with null.
  The daemon confirmed Fast as `priority` and Standard as `default`.
- Both modes produced a Luna reply; a fresh RPC connection recovered each setting.
- Android API 35/Gboard verified Fast, Standard, effective status, app restart,
  a Luna reply in Fast, and `/fast` opening controls without adding a prompt.
- Model, effort and permission settings remained intact.
- 338 client tests, 30 gateway tests, TypeScript and version parity passed.
- Signed ARM64 and x86_64 release APKs passed certificate, version, ABI,
  non-debuggable and 16 KiB alignment checks, with identical JS bundles.

## Reproduce

Run `server/codex/fast-live-check.mjs` with `CODEX_FAST_REPORT` pointing to an
absolute JSON output. Set `CODEX_FAST_KEEP_FIXTURE=1` for the Android follow-up.
With the release APK installed and the gateway connection saved, run
`scripts/android-cua-smoke.py --scenarios codex_fast --include-xml`. Provide
`CODEX_GATEWAY_URL`, `CODEX_GATEWAY_USERNAME`, `CODEX_GATEWAY_PASSWORD_FILE`,
`CODEX_FAST_REPORT` and `ANDROID_CODEX_OUTPUT_DIR`. Delete the exact fixture
thread via native `thread/delete` afterward. Credentials stay in private files.

The inverted chat list may retain its position after a reply; the UI check closes
the keyboard and scrolls to the latest message before asserting visibility.
