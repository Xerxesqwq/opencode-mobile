# Session navigation — 0.4.23 (51)

## Reproduced failure

With 0.4.22, open B, select A, and make A's message request fail. Android
continues showing B's title, messages and composer. The local transport fixture
reproduced this without contacting a model or changing a user session.
Four tests against the previous Zustand store also failed: selecting A leaves
B visible, an old background refresh overwrites A, an old history page overwrites
A, and a failed A load leaves B displayed.

## Change

Selection records its destination immediately and clears the previous content.
Conversation loading has separate state from session-list loading. Background
refresh and history results must still match their original selection and
connection before changing the store. Responses containing another session's ID
are rejected. Same-session background refreshes keep current content visible.

Each chat route displays only its own selected session. Failed loads expose a
retry action; sending and session actions stay disabled until that session is
ready. Actions recheck ownership after asynchronous authentication or dialogs.

## Validation

- 353 client tests (including 13 navigation regressions), 37 gateway tests,
  TypeScript and version parity passed.
- Android API 35 verified slow loading, failed loading and retry, late B refreshes
  after A opens, repeated A/B selection, return from a second chat with A's
  unsent draft intact, and a canned prompt arriving only in A. All session
  requests carried the corresponding project directory.
- Read-only live requests verified both original conversation IDs and every
  returned message ID. Android switched between the original Chiikawa and
  development conversations twice each and retained the correct route/content
  identity during live updates. No inference or session mutations were requested.
- Both signed release APKs passed package/version/certificate/ABI/release and
  16 KiB alignment checks. Phone and emulator contain the same JS bundle.

The gateway remains 0.6.0. No production server change is required. Native model
inference requests for this regression: zero. All screenshots show local fixtures.

## Reproduce

Run `node --test src/lib/session-navigation.test.ts` for the actual store with
only native services and transport stubbed. Node 22.15 or newer is required.

Run `node tests/fixtures/session-navigation-server.mjs` on the test machine. It
binds to loopback port 14101 (`NAVIGATION_PORT` can override this). With the APK
installed and the emulator running, use
`scripts/check-session-navigation.py --setup --output-dir /absolute/output` to
add its local connection and run the deterministic checks. Later runs can use
`scripts/android-cua-smoke.py --scenarios session_navigation --include-xml` with
`ANDROID_CODEX_OUTPUT_DIR` pointing to the output directory. Restart the fixture
server before each full run. `--expect-bug` reproduces the old APK's failure.

The fixture's fork endpoint returns its seeded B session to test the native
back stack. Its prompt endpoint records a canned submission. Neither calls a
model. The fixture closes an SSE stream after the requested event so Android
can flush the background-refresh trigger even when its transport buffers data.

For read-only Android checks with existing sessions, set
`NAVIGATION_LIVE_CONNECTION` to an existing saved connection name and
`NAVIGATION_LIVE_IDS` to two comma-separated session IDs, then run
`scripts/check-session-navigation-live.py --output-dir /absolute/output`. It
checks route/content identity and stability during live updates without saving
screenshots of user content.

The local fixture server was stopped and its saved Android connection removed.
The production connection and user sessions were preserved.
