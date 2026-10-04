# Codex gateway for OpenCode Mobile

Connect the Android app directly to a server running Codex. The gateway translates the app's REST/SSE requests into Codex app-server JSON-RPC over its private Unix socket. Model inference continues to use the server's configured provider and login.

Tested protocol: Codex CLI/app-server **0.160.0**. The experimental paginated history API is enabled. Use matching daemon and CLI versions when upgrading.

## Supported operations

- List existing sessions across directories, open their history, and rename them.
- Join a live thread owned by the same Codex daemon; continue or steer its active turn, and interrupt it.
- Create sessions in a selected existing directory.
- Stream assistant text, reasoning summaries, shell output and other tool results.
- Save model and reasoning effort to the current session using the daemon's current catalog, including max/ultra where supported.
- Change sandbox permission profiles, approval policy, and plan/default mode; reflect effective settings confirmed by Codex.
- Compact context after the active turn finishes, inspect context and cumulative token usage, and view account usage windows.
- Inspect live task plans, loaded instruction paths, and the latest turn's file diff.
- Search all stored conversation turns, with prompt/reply/tool filters and message links.
- Fork the complete conversation or start before a selected prompt. The branch inherits effective model, reasoning, permission and approval settings and waits for explicit input. Both conversations share the current directory and files.
- Rewind from a user prompt after saving a complete backup, then edit and retry. File contents remain unchanged.
- Review recorded file patches by turn and path, with line numbers, syntax colors, and collapsible context.
- Archive and restore up to 100 selected sessions, with per-session failure reporting.
- Monitor all loaded tasks and 100 recent sessions, including approval/input waits and failures; jump to or stop a running task.
- Send text and embedded images.
- Answer command/file/permission approvals and structured questions. Pending requests stay on the server while the phone disconnects. Requests resolved on another client disappear here too.

Existing threads retain their permissions, model and reasoning effort until the user changes them. Prompts inherit the effective session settings. New threads use `workspace-write` and `on-request`. A phone disconnect leaves the Codex task running.

Live takeover applies to threads loaded in the daemon addressed by `CODEX_SOCKET`. A separate standalone CLI process can have its own runtime; a stored rollout alone does not give this gateway control of that process.

Dynamic tools and authentication/attestation requests owned by another Codex client still require that client. The gateway reports these requests and leaves their handling with the owner. Deletion and OpenCode-specific slash commands remain unavailable. Rewind changes conversation history and saves a named backup first; local files keep their current contents. Rewinding or archiving an active task requires stopping it first. Recorded patches describe historical edits and can differ from the current working tree.

## Start

Requirements: Linux/macOS, Node.js 22+, a locally authenticated Codex daemon, and a TLS endpoint for access from your phone.

```sh
cd server/codex
npm ci --omit=dev
codex app-server daemon version
```

If no daemon is running, start it with `codex app-server daemon start`. Run the gateway as the **same user** as Codex. It never reads or exports your Codex authentication file.

Create a private password file once:

```sh
install -d -m 700 "$HOME/.config/opencode-codex"
(umask 077; openssl rand -base64 10 > "$HOME/.config/opencode-codex/password")
export CODEX_GATEWAY_PASSWORD_FILE="$HOME/.config/opencode-codex/password"
export CODEX_GATEWAY_DIRECTORY="$HOME"
node main.mjs
```

Default listener: `127.0.0.1:4098`. Default username: `opencode`. Default socket: `$CODEX_HOME/app-server-control/app-server-control.sock`, with `CODEX_HOME` defaulting to `~/.codex`.

The gateway password grants access to this user's Codex sessions and filesystem browsing. Keep it in a private file. The Android app saves it in SecureStore. No default password is shipped.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `CODEX_SOCKET` | Override the existing daemon's absolute Unix socket path |
| `CODEX_GATEWAY_PASSWORD_FILE` | Required password file, at least 16 characters |
| `CODEX_GATEWAY_USERNAME` | Basic-auth username, defaults to `opencode` |
| `CODEX_GATEWAY_DIRECTORY` | Starting directory for new sessions and browsing |
| `CODEX_GATEWAY_HOST` / `CODEX_GATEWAY_PORT` | Listener, defaults to `127.0.0.1:4098` |
| `CODEX_GATEWAY_TLS_CERT` / `CODEX_GATEWAY_TLS_KEY` | Certificate and key for native HTTPS |

Public listeners require TLS. A loopback listener can sit behind Caddy. Browser `Origin` requests are rejected to prevent browser pages from using ambient credentials. Requests are capped at 12 MiB; slow SSE readers are disconnected and can refresh their session.

## Caddy

Reuse a valid certificate already managed on your server:

```caddyfile
https://your-domain.example:15317 {
    tls /path/to/certificate.crt /path/to/private.key
    reverse_proxy 127.0.0.1:4098 {
        flush_interval -1
    }
}
```

Forward the router's external port to this Caddy listener and permit it in the host firewall. Keep the gateway's HTTP port on loopback. Preserve existing OpenCode proxy routes.

## Android

Add a connection, select **Codex**, enter the HTTPS URL, username `opencode`, and the gateway password. Choose a directory for new sessions. The session list includes existing directories automatically. Open the chart icon in a chat header for the Codex control panel. The toolbar also opens model, effort and mode selection. Use the search and file icons in the chat header for history search and file review. Tap the rewind button on a user message, or long-press its header, to back up and rewind from that prompt. The branch icon forks before that prompt and restores it as a draft in the new branch. The status panel also offers a full conversation fork. Forking is available after the current task finishes. The session screen opens the task dashboard and session organizer. Commands `/compact`, `/effort`, `/permissions`, `/status`, `/context`, `/plan`, `/fast`, `/model` and `/new` run locally or open the matching controls.

Context uses the native `last.totalTokens` and `modelContextWindow`; cached input and reasoning output are subsets, not additional tokens. Codex 0.160 metadata-only resume omits usage replay for loaded threads. The gateway restores the latest token-count record from at most the last 8 MiB of the daemon-provided rollout, restricted to the daemon's state directory. It returns only token counts; live notifications supersede the restored snapshot. If no snapshot is available, the panel waits for the next native usage event.

## Verification

```sh
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Tests exercise protocol framing through a real Unix WebSocket, REST/SSE authentication and approval round trips, replay deduplication, disconnect recovery, existing history, guarded steering, interruptions, and permission decisions. Live model and Android UI checks are additional release gates.

Opt-in live checks create dedicated test threads:

```sh
CODEX_WORKBENCH_FIXTURE=/absolute/path/to/dedicated-test-directory node workbench-live-check.mjs
CODEX_WORKBENCH_FIXTURE=/absolute/path/to/dedicated-test-directory node fork-live-check.mjs
node live-controls-check.mjs
CODEX_GATEWAY_URL=https://your-host:port \
CODEX_GATEWAY_USERNAME=opencode \
CODEX_GATEWAY_PASSWORD_FILE="$HOME/.config/opencode-codex/password" \
node live-check.mjs
```

### Fast mode

Gateway 0.5.0 exposes each model's native `serviceTiers` in `/codex/options`.
PATCH `/session/:id/codex` with `{"serviceTier":"priority"}` enables Fast when
that tier appears in the selected model's catalog. `{"serviceTier":null}` clears
the tier; Codex 0.160 reports Standard as `default`. Omission preserves the current
setting. Model changes clear an incompatible tier. Native settings notifications
confirm the result; the Mode and Status panels show that effective value.

Run opt-in checks with Luna to limit cost. The native scripts select `gpt-6-luna`,
and the Android model-switch check chooses another Luna model. Fast validation:

```sh
CODEX_FAST_REPORT=/absolute/path/report.json node fast-live-check.mjs
```

The check deletes its fixture by default. Set `CODEX_FAST_KEEP_FIXTURE=1` only
when following with `scripts/check-codex-fast.py` or the `codex_fast` CUA scenario;
delete that exact report's thread through `thread/delete` after UI verification.
