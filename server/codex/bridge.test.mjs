import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'
import { input } from './mapping.mjs'

const thread = () => ({ id: 'existing', cwd: '/workspace', name: 'Existing session', createdAt: 100, updatedAt: 101, status: { type: 'idle' }, model: 'test-model', turns: [] })
class RPC extends EventEmitter {
  calls = []
  replies = []
  async connect() { return { userAgent: 'Codex/0.160.0', codexHome: '/private' } }
  async call(method, params) {
    this.calls.push({ method, params })
    if (method === 'thread/resume') return { thread: thread() }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn1', status: 'completed', startedAt: 100, completedAt: 101, items: [{ id: 'user1', type: 'userMessage', content: [{ type: 'text', text: 'Existing prompt' }] }, { id: 'assistant1', type: 'agentMessage', text: 'Existing response' }] }], nextCursor: null }
    if (method === 'thread/start') return { thread: { ...thread(), id: 'new' } }
    if (method === 'turn/start') return { turn: { id: 'turn2', status: 'inProgress', items: [] } }
    if (method === 'thread/loaded/list') return { data: ['existing', 'new'], nextCursor: null }
    if (method === 'thread/read') return { thread: { ...thread(), id: params.threadId, updatedAt: 102 } }
    if (method === 'thread/list') return { data: [thread()], nextCursor: null }
    return {}
  }
  reply(id, result) { this.replies.push({ id, result }) }
}

function fixture() { const rpc = new RPC(); return { rpc, bridge: new Bridge(rpc) } }

test('resumes the existing thread without replacing permissions or model, hydrates real messages', async () => {
  const { rpc, bridge } = fixture()
  const history = await bridge.history('existing')
  assert.equal(history[0].parts[0].text, 'Existing prompt')
  assert.equal(history[1].parts[0].text, 'Existing response')
  assert.deepEqual(rpc.calls[0], { method: 'thread/resume', params: { threadId: 'existing', excludeTurns: true } })
  await bridge.history('existing')
  assert.equal(rpc.calls.filter(c => c.method === 'thread/resume').length, 1)
})

test('streams deltas, finishes the turn, and uses guarded steer for active turns', async () => {
  const { rpc, bridge } = fixture(); await bridge.attach('existing')
  const events = []; bridge.on('event', e => events.push(e))
  bridge.receive({ method: 'turn/started', params: { threadId: 'existing', turn: { id: 'turn2', status: 'inProgress', items: [] } } })
  bridge.receive({ method: 'item/started', params: { threadId: 'existing', turnId: 'turn2', item: { id: 'answer', type: 'agentMessage', text: '' } } })
  bridge.receive({ method: 'item/agentMessage/delta', params: { threadId: 'existing', turnId: 'turn2', itemId: 'answer', delta: 'Hello' } })
  await new Promise(resolve => setTimeout(resolve, 65))
  assert.equal(events.at(-1).properties.part.text, 'Hello')
  await bridge.prompt('existing', { parts: [{ type: 'text', text: 'Continue' }] })
  assert.equal(rpc.calls.at(-1).method, 'turn/steer')
  assert.equal(rpc.calls.at(-1).params.expectedTurnId, 'turn2')
  await bridge.abort('existing')
  assert.deepEqual(rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'existing', turnId: 'turn2' } })
  bridge.receive({ method: 'turn/completed', params: { threadId: 'existing', turn: { id: 'turn2', status: 'completed', items: [] } } })
  assert.equal(events.at(-1).properties.status.type, 'idle')
  assert.equal(bridge.threads.get('existing').turns.get('turn2').items[0].text, 'Hello')
})

test('new sessions have explicit scoped permissions; continuation inherits settings', async () => {
  const { rpc, bridge } = fixture()
  assert.equal((await bridge.create('/workspace')).id, 'new')
  assert.deepEqual(rpc.calls[0].params, { cwd: '/workspace', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  await bridge.prompt('new', { parts: [{ type: 'text', text: 'Hi' }] })
  assert.equal(rpc.calls.at(-1).params.model, undefined)
  assert.equal(rpc.calls.at(-1).params.approvalPolicy, undefined)
})

test('pending approvals survive mobile reconnect, deduplicate replay, and disappear when another client answers', () => {
  const { rpc, bridge } = fixture()
  const packet = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'existing', itemId: 'cmd', command: 'echo hello', availableDecisions: ['accept', 'decline'] } }
  bridge.receive(packet); bridge.receive(packet)
  assert.equal(bridge.pending.size, 1)
  assert.equal(rpc.replies.length, 0)
  const id = [...bridge.pending.keys()][0]
  assert.throws(() => bridge.reply(id, { reply: 'always' }, false), /does not offer/)
  bridge.reply(id, { reply: 'once' }, false)
  assert.deepEqual(rpc.replies, [{ id: 7, result: { decision: 'accept' } }])
  assert.throws(() => bridge.reply(id, { reply: 'once' }, false), /already resolved/)
  bridge.receive({ ...packet, id: 8 })
  bridge.receive({ method: 'serverRequest/resolved', params: { threadId: 'existing', requestId: 8 } })
  assert.equal(bridge.pending.size, 0)
})

test('questions preserve answer mapping; declining permissions grants nothing', () => {
  const { rpc, bridge } = fixture()
  bridge.receive({ id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'existing', questions: [{ id: 'choice', question: 'Pick', header: 'Choice', options: [{ label: 'A', description: 'First' }] }] } })
  bridge.reply([...bridge.pending.keys()][0], { answers: [['A']] }, true)
  assert.deepEqual(rpc.replies[0].result, { answers: { choice: { answers: ['A'] } } })
  bridge.receive({ id: 'p', method: 'item/permissions/requestApproval', params: { threadId: 'existing', itemId: 'p', permissions: { network: { enabled: true } } } })
  bridge.reply([...bridge.pending.keys()][0], { reply: 'reject' }, false)
  assert.deepEqual(rpc.replies[1].result, { permissions: {}, scope: 'turn' })
})

test('daemon disconnect invalidates cached history and pending requests', async () => {
  const { rpc, bridge } = fixture(); await bridge.attach('existing')
  rpc.emit('disconnect'); assert.equal(bridge.threads.size, 0)
  await bridge.history('existing')
  assert.equal(rpc.calls.filter(c => c.method === 'thread/resume').length, 2)
})

test('rejects unsupported attachments before starting a turn', () => {
  assert.throws(() => input([{ type: 'file', mime: 'text/plain', url: 'file:///etc/passwd' }]), /supports text/)
})

test('HTTP authentication, origin rejection, history, and unsupported mutation', async t => {
  const { rpc, bridge } = fixture()
  const password = 'a-long-test-password-123456'
  const server = createGateway({ bridge, password })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}` }
  assert.equal((await fetch(url + '/global/health')).status, 401)
  assert.equal((await fetch(url + '/global/health', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await (await fetch(url + '/global/health', { headers })).json()).backend, 'codex')
  const history = await (await fetch(url + '/session/existing/message', { headers })).json()
  assert.equal(history[1].parts[0].text, 'Existing response')
  assert.equal((await fetch(url + '/session/existing/revert', { method: 'POST', headers, body: '{}' })).status, 501)
  assert.equal(rpc.calls.some(c => c.method.includes('rollback')), false)
})


test('full history follows pagination and limited history keeps the newest messages', async () => {
  const { rpc, bridge } = fixture()
  const call = rpc.call.bind(rpc)
  rpc.call = async (method, params) => {
    if (method !== 'thread/turns/list') return call(method, params)
    const older = Boolean(params.cursor)
    return { data: [{ id: older ? 'old' : 'new', status: 'completed', startedAt: older ? 1 : 2, completedAt: 3, items: [{ id: older ? 'old-message' : 'new-message', type: 'agentMessage', text: older ? 'Old' : 'New' }] }], nextCursor: older ? null : 'older' }
  }
  const all = await bridge.history('existing')
  assert.deepEqual(all.map(row => row.parts[0].text), ['Old', 'New'])
  assert.deepEqual((await bridge.history('existing', 1)).map(row => row.parts[0].text), ['New'])
})

test('a closed thread is resumed again on the next open', async () => {
  const { rpc, bridge } = fixture()
  await bridge.attach('existing')
  bridge.receive({ method: 'thread/closed', params: { threadId: 'existing' } })
  await bridge.attach('existing')
  assert.equal(rpc.calls.filter(c => c.method === 'thread/resume').length, 2)
})

test('lists empty loaded sessions alongside persisted history without duplicates', async () => {
  const { bridge, rpc } = fixture()
  const rows = await bridge.list()
  assert.deepEqual(rows.map(row => row.id), ['new', 'existing'])
  assert.deepEqual(rpc.calls.filter(call => call.method === 'thread/read'), [
    { method: 'thread/read', params: { threadId: 'new', includeTurns: false } },
  ])
})
