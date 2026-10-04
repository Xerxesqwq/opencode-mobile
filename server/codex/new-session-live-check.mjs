// Opt-in native check: empty sessions, reconnect and first message using Luna.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
const socket = path.join(homedir(), '.codex/app-server-control/app-server-control.sock')
const first = new CodexRPC(socket), second = new CodexRPC(socket)
let id

try {
  await first.connect()
  const createdBridge = new Bridge(first)
  const created = await createdBridge.create(process.cwd())
  id = created.id
  assert.deepEqual(await createdBridge.history(id), [])
  first.close()
  await second.connect()
  const reconnected = new Bridge(second)
  assert.deepEqual(await reconnected.history(id), [])
  assert.equal(reconnected.describe(reconnected.threads.get(id).thread).id, id)
  const done = new Map()
  second.on('message', packet => { if (packet.method === 'turn/completed' && packet.params.threadId === id) done.set(packet.params.turn.id, packet.params.turn) })
  const { turn } = await reconnected.prompt(id, { model: { providerID: 'codex', modelID: 'gpt-6-luna' }, parts: [{ type: 'text', text: 'Reply exactly NEW_SESSION_OK. Do not use tools.' }] })
  const end = Date.now() + 90000
  while (!done.has(turn.id) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(done.get(turn.id)?.status, 'completed')
  assert((await reconnected.history(id)).some(row => row.parts.some(part => part.type === 'text' && part.text.includes('NEW_SESSION_OK'))))
  const report = { passed: true, model: 'gpt-6-luna', inferenceRequests: 1, checks: ['empty history after creation', 'empty history after native reconnect', 'same identity', 'Luna first message', 'persisted history'] }
  if (process.env.CODEX_NEW_REPORT) await writeFile(process.env.CODEX_NEW_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  if (id) { await second.connect(); await second.call('thread/delete', { threadId: id }) }
  first.close(); second.close()
}
