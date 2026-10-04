// Opt-in native integration check; changes only its newly created fixture threads.
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
  const title = `Workbench ${Date.now()}`
  const source = await request('/session', { title })
  const first = await prompt(source.id, 'Use apply_patch to create a.py with exactly two lines: # WORKBENCH_OLD_MARKER and print("alpha"). Create b.py containing print("beta"). Work only in this directory. Reply FILES_READY.')
  const secondText = 'Reply exactly WORKBENCH_RETRY_MARKER. Do not use tools.'
  const second = await prompt(source.id, secondText)
  const search = await request(`/session/${source.id}/codex/search?q=WORKBENCH_OLD_MARKER&kind=user`)
  assert.equal(search.results[0].turnId, first.id)
  const files = await request(`/session/${source.id}/codex/files`)
  assert(files.files.some(file => file.path.endsWith('a.py') && /\+print/.test(file.diff))); assert(files.files.some(file => file.path.endsWith('b.py')))
  const fingerprint = async () => createHash('sha256').update(await readFile(path.join(cwd, 'a.py'))).update(await readFile(path.join(cwd, 'b.py'))).digest('hex')
  const before = await fingerprint()
  const result = await request(`/session/${source.id}/codex/revert`, { beforeTurnId: second.id })
  assert.equal(result.draft.text, secondText)
  assert.deepEqual((await allTurns(rpc, source.id)).map(turn => turn.id), [first.id])
  assert.equal((await allTurns(rpc, result.backup.id)).length, 2)
  assert.equal(await fingerprint(), before)
  await prompt(source.id, secondText)
  const ids = [source.id, result.backup.id]
  assert((await request('/codex/archive', { ids, archived: true })).results.every(row => row.ok))
  const archived = await request('/codex/library?archived=true')
  assert(ids.every(id => archived.some(row => row.id === id)))
  assert((await request('/codex/archive', { ids, archived: false })).results.every(row => row.ok))
  const runner = await request('/session', { title: title + ' active task' })
  await rpc.call('turn/start', { threadId: runner.id, input: [{ type: 'text', text: 'Run sleep 45 once, then reply DONE. Do not change files.', text_elements: [] }] })
  await waitFor(async () => (await rpc.call('thread/read', { threadId: runner.id, includeTurns: false })).thread.status.type === 'active')
  const tasks = await request('/codex/tasks')
  assert.equal(tasks.items.find(item => item.session.id === runner.id)?.state, 'running')
  await request(`/session/${runner.id}/abort`, {})
  await waitFor(async () => (await allTurns(rpc, runner.id))[0]?.status === 'interrupted')
  const report = { source: source.id, backup: result.backup.id, runner: runner.id, title, cwd, firstTurn: first.id, files: files.files.map(file => file.path), checks: ['native full-history search', 'two grouped file patches', 'backup before revert', 'files unchanged', 'retry', 'batch archive and restore', 'global running task and stop'], passed: true }
  if (process.env.CODEX_WORKBENCH_REPORT) await writeFile(process.env.CODEX_WORKBENCH_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await new Promise(resolve => server.close(resolve)); rpc.close() }
