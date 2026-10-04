// Opt-in live integration check. Creates only a dedicated test thread.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexRPC } from './rpc.mjs'
const password = (await readFile(process.env.CODEX_GATEWAY_PASSWORD_FILE, 'utf8')).trim()
const base = process.env.CODEX_GATEWAY_URL || 'http://127.0.0.1:4098'
const headers = { Authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'Content-Type': 'application/json' }
const request = async (route, body) => {
  const response = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
const rpc = new CodexRPC(process.env.CODEX_SOCKET || path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
await rpc.connect()
const created = await rpc.call('thread/start', { cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'on-request' })
const id = created.thread.id
await rpc.call('thread/name/set', { threadId: id, name: 'Codex Mobile live takeover test' })
console.log('Dedicated existing thread:', id)
const waiting = new Map()
rpc.on('message', packet => {
  if (packet.params?.threadId !== id) return
  for (const [key, item] of waiting) if (item.match(packet)) { waiting.delete(key); item.resolve(packet) }
})
const wait = match => new Promise((resolve, reject) => {
  const key = Symbol()
  const timer = setTimeout(() => { waiting.delete(key); reject(new Error('Live protocol timeout')) }, 90000)
  waiting.set(key, { match, resolve: value => { clearTimeout(timer); resolve(value) } })
})
try {
  const started = wait(p => p.method === 'item/started' && p.params.item.type === 'commandExecution')
  await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text: 'Run exactly this shell command once: sleep 30; printf CODEX_INTERRUPT_TEST. Do not modify files. After it completes, reply DONE.', text_elements: [] }] })
  await started
  // The original client still owns a live turn when the mobile gateway joins.
  const session = await request(`/session/${id}`)
  assert.equal(session.id, id)
  const history = await request(`/session/${id}/message`)
  assert(history.some(m => m.info.role === 'user'))
  const completed = wait(p => p.method === 'turn/completed')
  await request(`/session/${id}/abort`, {})
  const final = await completed
  assert.equal(final.params.turn.status, 'interrupted')
  console.log('PASS: joined existing active session; history loaded; gateway interrupt observed on original client')
} finally {
  rpc.close()
}
