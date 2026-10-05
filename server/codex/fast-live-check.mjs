// Opt-in native check. Every inference uses Luna; fixtures are deleted by default.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'

const rpc = new CodexRPC(path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
await rpc.connect()
const bridge = new Bridge(rpc), password = randomBytes(24).toString('base64')
const server = createGateway({ bridge, password, directory: process.cwd() })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' }
const request = async (route, method = 'GET', body) => {
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}
const model = 'gpt-6-luna', ids = []
let passed = false
try {
  const catalog = await request('/codex/options')
  const tier = catalog.models.find(m => m.id === model)?.serviceTiers.find(t => ['priority', 'fast'].includes(t.id))
  assert(tier, 'Luna Fast must be available for this check')
  const title = `Fast Luna check ${Date.now()}`
  const session = await request('/session', 'POST', { title })
  ids.push(session.id)
  const route = `/session/${session.id}/codex`
  const baseline = await request(route, 'PATCH', { model, effort: 'low', serviceTier: null })
  assert.equal(baseline.codex.model, model)
  for (const serviceTier of [tier.id, null]) {
    const updated = await request(route, 'PATCH', { serviceTier })
    assert.equal(updated.codex.serviceTier, serviceTier ?? 'default')
    assert.equal(updated.codex.model, model)
    assert.equal(updated.codex.effort, 'low')
    assert.deepEqual(updated.codex.sandboxPolicy, baseline.codex.sandboxPolicy)
    const done = new Map()
    const listener = p => { if (p.method === 'turn/completed' && p.params.threadId === session.id) done.set(p.params.turn.id, p.params.turn) }
    rpc.on('message', listener)
    try {
      // Explicit model prevents an expensive account default from being used.
      const { turn } = await rpc.call('turn/start', { threadId: session.id, model, input: [{ type: 'text', text: 'Reply exactly FAST_CHECK_OK. Do not use tools.', text_elements: [] }] })
      const deadline = Date.now() + 90000
      while (!done.has(turn.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(done.get(turn.id)?.status, 'completed')
      assert(done.get(turn.id).items.some(item => item.type === 'agentMessage' && item.text.includes('FAST_CHECK_OK')))
    } finally { rpc.off('message', listener) }
    const reconnected = new CodexRPC(rpc.socket)
    try {
      await reconnected.connect()
      const resumed = await reconnected.call('thread/resume', { threadId: session.id, excludeTurns: true })
      assert.equal(resumed.serviceTier, serviceTier ?? 'default')
      assert.equal(resumed.model, model)
    } finally { reconnected.close() }
  }
  const report = { source: session.id, title, model, fastTier: tier.id, passed: true,
    checks: ['catalog capability', 'Fast on', 'Standard off', 'Luna replies in both modes', 'native reconnect persistence', 'effort and permissions preserved'] }
  if (process.env.CODEX_FAST_REPORT) await writeFile(process.env.CODEX_FAST_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  passed = true
} finally {
  if (!passed || process.env.CODEX_FAST_KEEP_FIXTURE !== '1') {
    for (const threadId of ids.reverse()) await rpc.call('thread/delete', { threadId })
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rpc.close()
}
