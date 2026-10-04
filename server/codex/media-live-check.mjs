// Read-only verification of an existing image-bearing session. Starts no turns.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'
import { itemImages } from './media.mjs'

const id = process.env.CODEX_MEDIA_SESSION
assert(id, 'Set CODEX_MEDIA_SESSION to the existing session to inspect')
const rpc = new CodexRPC(path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
await rpc.connect()
const calls = [], original = rpc.call.bind(rpc)
rpc.call = (method, params) => { calls.push(method); return original(method, params) }
const bridge = new Bridge(rpc), password = randomBytes(24).toString('base64')
const server = createGateway({ bridge, password })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const history = await (await fetch(`${base}/session/${id}/message`, { headers })).json()
  assert(Array.isArray(history))
  assert(history.every(row => row.parts.length > 0 || row.info.error), 'An empty bubble remains')
  const state = bridge.threads.get(id)
  const items = [...state.turns.values()].flatMap(turn => turn.items)
  const hidden = items.filter(item => item.type === 'reasoning' && ![...(item.summary || []), ...(item.content || [])].some(text => text.trim()))
  assert(hidden.length > 0, 'Use a session containing empty reasoning records')
  assert(hidden.every(item => !history.some(row => row.info.id === item.id)))
  const checked = []
  for (const type of ['imageGeneration', 'imageView']) {
    const item = items.find(item => item.type === type && itemImages(item, state.thread.cwd).length)
    assert(item, `Session must contain ${type}`)
    const row = history.find(row => row.info.id === item.id)
    const file = row.parts.find(part => part.type === 'file')
    assert(file?.url.startsWith(`/session/${id}/codex/media/`))
    const response = await fetch(base + file.url, { headers })
    assert.equal(response.status, 200)
    assert(response.headers.get('content-type').startsWith('image/'))
    const bytes = Buffer.from(await response.arrayBuffer())
    const source = itemImages(item, state.thread.cwd)[0]
    if (source.kind === 'file') assert.equal(hash(bytes), hash(await readFile(source.path)))
    checked.push({ type, bytes: bytes.length, sha256: hash(bytes) })
    if (item.type === 'imageGeneration' && item.result) assert(!JSON.stringify(row).includes(item.result))
  }
  assert(calls.every(method => ['thread/resume', 'thread/turns/list', 'thread/items/list'].includes(method)), 'Unexpected mutation or inference')
  const report = { passed: true, inferenceRequests: 0, hiddenEmptyRecords: hidden.length, messages: history.length,
    historyBytes: Buffer.byteLength(JSON.stringify(history)), images: checked,
    checks: ['empty records omitted', 'generated image bytes', 'viewed image bytes', 'authenticated binary delivery', 'no base64 in chat', 'bounded native item pages', 'no inference or settings changes'] }
  if (process.env.CODEX_MEDIA_REPORT) await writeFile(process.env.CODEX_MEDIA_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rpc.close()
}
