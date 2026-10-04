# Codex images — 0.4.22 (50)

Gateway 0.6.0, Codex app-server 0.160.0, Android API 35.

- Read-only source inspection omitted 121 empty records and verified generated
  and viewed image bytes against their original files. No inference or settings
  requests were made against the user's session.
- Android displayed both image types from the existing session. Preview,
  full-screen zoom/reset/close, local Markdown images, missing-file error and
  retry recovery passed. Screenshots contain only the dedicated test fixture.
- Fixture creation used one gpt-6-luna turn. Android interaction was deterministic.
- 340 client and 37 gateway tests, TypeScript and version parity passed.
- Signed ARM64 and x86_64 release APKs passed version, certificate, ABI,
  non-debuggable and 16 KiB alignment checks, with identical JS bundles.

## Reproduce

Run `server/codex/media-live-check.mjs` with `CODEX_MEDIA_SESSION` and
`CODEX_MEDIA_REPORT` for an existing image-bearing session. It is read-only.
For UI checks, run `scripts/seed-codex-media.mjs` with absolute
`CODEX_MEDIA_FIXTURE_DIR` and `CODEX_MEDIA_FIXTURE` paths. It creates a simple
PNG locally and uses Luna to view it and emit Markdown.

With the release APK installed and a saved gateway connection, run
`scripts/android-cua-smoke.py --scenarios codex_media --include-xml`. Provide
`CODEX_MEDIA_FIXTURE`, `CODEX_GATEWAY_URL`, `CODEX_GATEWAY_USERNAME`,
`CODEX_GATEWAY_PASSWORD_FILE` and `ANDROID_CODEX_OUTPUT_DIR`. Optionally set
`CODEX_MEDIA_ORIGINAL` for the read-only source image checks. Delete the fixture's
exact thread through native `thread/delete` and remove its files afterward.
Remove fixture `missing.png` before rerunning the recovery check.

The search target is an absolute sibling highlight in Android's accessibility
hierarchy; the check selects a loaded preview within that highlight's bounds.

## Dependency audit

The gateway runtime audit reports zero vulnerabilities. The mobile dependency
audit reports 47 existing findings (1 low, 14 moderate, 30 high, 2 critical);
this change updates only version metadata in the mobile lockfile. Dependency
upgrades need a separate compatibility update.

The dedicated fixture was deleted through native `thread/delete` after the
Android checks. The original session and its image files were preserved.
