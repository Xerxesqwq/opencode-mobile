import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'

const env = process.env
const host = env.CODEX_GATEWAY_HOST || '127.0.0.1'
const port = Number(env.CODEX_GATEWAY_PORT || 4098)
const socket = env.CODEX_SOCKET || join(env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock')
const tls = env.CODEX_GATEWAY_TLS_CERT && env.CODEX_GATEWAY_TLS_KEY ? {
  cert: await readFile(env.CODEX_GATEWAY_TLS_CERT), key: await readFile(env.CODEX_GATEWAY_TLS_KEY),
} : undefined
if (!tls && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Public listeners require CODEX_GATEWAY_TLS_CERT and CODEX_GATEWAY_TLS_KEY; use loopback for a reverse proxy')
if (!env.CODEX_GATEWAY_PASSWORD_FILE) throw new Error('Set CODEX_GATEWAY_PASSWORD_FILE to a private file containing a generated password')
const password = (await readFile(env.CODEX_GATEWAY_PASSWORD_FILE, 'utf8')).trim()
const rpc = new CodexRPC(socket)
await rpc.connect()
const bridge = new Bridge(rpc)
const server = createGateway({ bridge, password, username: env.CODEX_GATEWAY_USERNAME || 'opencode', directory: resolve(env.CODEX_GATEWAY_DIRECTORY || homedir()), tls })
server.listen(port, host, () => console.log(`Codex gateway listening on ${tls ? 'https' : 'http'}://${host}:${port}`))
const stop = () => { server.close(); server.closeAllConnections(); rpc.close() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
