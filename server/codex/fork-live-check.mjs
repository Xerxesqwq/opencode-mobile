// Opt-in fork integration check; changes only its newly created fixture threads.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'
import { allTurns } from './workbench.mjs'
const cwd = process.env.CODEX_WORKBENCH_FIXTURE
assert(cwd && path.isAbsolute(cwd), 'Set CODEX_WORKBENCH_FIXTURE to a dedicated absolute test directory')
await mkdir(cwd, { recursive: true })
const rpc = new CodexRPC(process.env.CODEX_SOCKET || path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
await rpc.connect()
const bridge = new Bridge(rpc), password = randomBytes(24).toString('base64')
const server = createGateway({ bridge, password, directory: cwd })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' }
const request = async (route, body) => {
  const response = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
const waitFor = async (predicate, limit = 120000) => {
  const end = Date.now() + limit
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)) }
  throw new Error('Dedicated fixture check timed out')
}
const prompt = async (id, text) => {
  const completed = new Map()
  const listener = packet => {
    if (packet.method === 'turn/completed' && packet.params.threadId === id) completed.set(packet.params.turn.id, packet.params.turn)
  }
  rpc.on('message', listener)
  try {
    const { turn } = await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }] })
    const final = await waitFor(() => completed.get(turn.id))
    assert.equal(final.status, 'completed')
    return final
  } finally { rpc.off('message', listener) }
}

try {
  const title = `Fork check ${Date.now()}`
  const source = await request('/session', { title })
  await bridge.updateSettings(source.id, { effort: 'low', permissions: ':read-only', approvalPolicy: 'untrusted', mode: 'plan' })
  const first = await prompt(source.id, 'Reply exactly FORK_FIRST. Do not use tools.')
  const second = await prompt(source.id, 'Reply exactly FORK_SECOND. Do not use tools.')
  await writeFile(path.join(cwd, 'sentinel.txt'), 'Shared files stay unchanged.\n')
  const before = JSON.stringify(await allTurns(rpc, source.id))
  const settings = bridge.describe((await bridge.attach(source.id)).thread).codex
  const full = await request(`/session/${source.id}/codex/fork`, {})
  assert.equal((await allTurns(rpc, full.session.id)).length, 2)
  assert.equal(full.draft, null)
  assert.equal(full.session.codex.model, settings.model)
  assert.equal(full.session.codex.effort, settings.effort)
  assert.equal(full.session.codex.mode, settings.mode)
  assert.deepEqual(full.session.codex.approvalPolicy, settings.approvalPolicy)
  assert.deepEqual(full.session.codex.sandboxPolicy, settings.sandboxPolicy)
  const partial = await request(`/session/${source.id}/codex/fork`, { beforeTurnId: second.id })
  assert.deepEqual((await allTurns(rpc, partial.session.id)).map(turn => turn.id), [first.id])
  assert.equal(partial.draft.text, 'Reply exactly FORK_SECOND. Do not use tools.')
  const empty = await request(`/session/${source.id}/codex/fork`, { beforeTurnId: first.id })
  assert.equal((await allTurns(rpc, empty.session.id)).length, 0)
  await prompt(partial.session.id, 'Reply exactly FORK_BRANCH_ONLY. Do not use tools.')
  assert.equal(JSON.stringify(await allTurns(rpc, source.id)), before)
  assert.equal(await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'), 'Shared files stay unchanged.\n')
  const report = { source: source.id, title, firstTurn: first.id, secondTurn: second.id, full: full.session.id, partial: partial.session.id, empty: empty.session.id, cwd,
    checks: ['full history fork', 'fork before selected turn', 'fork before first turn', 'editable draft', 'inherited model effort plan mode approvals read-only sandbox', 'branch continuation', 'source history unchanged', 'files unchanged'], passed: true }
  if (process.env.CODEX_WORKBENCH_REPORT) await writeFile(process.env.CODEX_WORKBENCH_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await new Promise(resolve => server.close(resolve)); rpc.close() }
