# Android /new and /clear — 0.4.24 (52), gateway 0.6.1

The 0.4.23 APK crashed when selecting `/new` from a long conversation with the
keyboard open. Android reported `SurfaceMountingManager.addViewAt`: the child
already had a parent. The same crash was reproduced against a local transport;
its creation counter confirmed that one empty session had been created before
the app exited. A failing creation request also left the old UI without an error.

The chat list now disables native child clipping during route changes. Creating
a session keeps the outgoing screen's store intact, dismisses the keyboard,
uses the current directory's client, guards repeated requests and reports errors.
`/clear` uses the same path to start a fresh conversation. Previous history stays
available.

Real-daemon verification exposed a second issue: before the first message,
`thread/turns/list` returns an explicit “not materialized” error. The gateway maps
only that native error to empty history. A still-loaded empty thread can be
reattached using metadata after resume reports a missing rollout. Its first
prompt restores the native subscription and effective settings. Two bounded
retries cover the daemon's initial rollout-file flush. Other history errors
remain visible.

## Verification

- 353 client tests, 40 gateway tests, TypeScript and version parity passed.
- Signed ARM64 and x86_64 APKs passed package/version/certificate/ABI/alignment
  checks and contain identical JavaScript bundles.
- Android API 35/Gboard: failed creation preserves the source, `/new` from a busy
  60-message conversation, repeated `/new` and `/clear`, directory preservation,
  empty composer, and return to original history. No inference in this fixture.
- Saved production connection: `/new` and `/clear` both opened usable empty
  conversations in the original directory. Both new IDs were checked through
  the authenticated gateway. No Android fatal exception occurred.
- Native check: empty history, immediate native reconnect, unchanged ID, first
  message explicitly using `gpt-6-luna`, completed reply and persisted history.
  The successful run used one inference request; all inference during debugging
  also explicitly used Luna. Its owned fixture was deleted in `finally`.
- The three Android-created empty fixtures are absent from the daemon. The saved
  test connection was removed; the production connection and user conversations
  were preserved. Emulator and local fixture server were stopped.

Native 0.160 keeps never-sent threads in memory and may discard them after all
subscriptions close. Reattachment here covers threads that remain loaded; the
first message makes history durable. Renaming an empty native thread can expose
a separate “missing source rollout” error, which remains visible.

Evidence: `crash-before.txt`, `android.json`, `live-android.json`, `native.json`,
`tests.json`, `apk-metadata.json`, cleanup reports and fixture screenshots.
