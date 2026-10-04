# Codex gateway for OpenCode Mobile

Connect the Android app directly to a server running Codex. The gateway translates the app's REST/SSE requests into Codex app-server JSON-RPC over its private Unix socket. Model inference continues to use the server's configured provider and login.

Tested protocol: Codex CLI/app-server **0.160.0**. The experimental paginated history API is enabled. Use matching daemon and CLI versions when upgrading.

## Supported operations

- List existing sessions across directories, open their history, and rename them.
- Join a live thread owned by the same Codex daemon; continue or steer its active turn, and interrupt it.
- Create sessions in a selected existing directory.
- Stream assistant text, reasoning summaries, shell output and other tool results.
- Choose models and reasoning effort from the daemon's current catalog.
- Send text and embedded images.
- Answer command/file/permission approvals and structured questions. Pending requests stay on the server while the phone disconnects. Requests resolved on another client disappear here too.

Existing threads retain their permissions and model unless the user explicitly selects another model for a new turn. New threads use `workspace-write` and `on-request`. A phone disconnect leaves the Codex task running.

Live takeover applies to threads loaded in the daemon addressed by `CODEX_SOCKET`. A separate standalone CLI process can have its own runtime; a stored rollout alone does not give this gateway control of that process.

Dynamic tools and authentication/attestation requests owned by another Codex client still require that client. The gateway reports these requests and leaves their handling with the owner. Revert, deletion, archiving, OpenCode slash commands and structured file-diff endpoints are unavailable; the app hides edit/delete actions for Codex connections. File changes remain visible as tool output.

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

Add a connection, select **Codex**, enter the HTTPS URL, username `opencode`, and the gateway password. Choose a directory for new sessions. The session list includes existing directories automatically. An unselected model inherits the session's settings.

## Verification

```sh
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Tests exercise protocol framing through a real Unix WebSocket, REST/SSE authentication and approval round trips, replay deduplication, disconnect recovery, existing history, guarded steering, interruptions, and permission decisions. Live model and Android UI checks are additional release gates.
