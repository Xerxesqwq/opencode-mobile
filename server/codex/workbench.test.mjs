import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Bridge } from './bridge.mjs'
import { searchHistory, fileChanges, forkHistory, revertHistory, archiveSessions, taskOverview, taskStatus } from './workbench.mjs'

const makeThread = id => ({ id, cwd: '/workspace', name: id, preview: '', model: 'model', modelProvider: 'test-provider', status: { type: 'idle' }, createdAt: 1, updatedAt: 2, canAcceptDirectInput: true })
const turn = (id, text) => ({ id, status: 'completed', startedAt: 1, items: [{ id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text }] }, { id: `${id}-reply`, type: 'agentMessage', text: 'Reply ' + text }] })
class RPC extends EventEmitter {
  records = new Map([['test', { thread: makeThread('test'), turns: [turn('t2', 'second'), turn('t1', 'first')], archived: false }]])
  calls = []
  async connect() { return {} }
  async call(method, params) {
    this.calls.push({ method, params })
    if (method === 'thread/list') return { data: [...this.records.values()].filter(row => row.archived === !!params.archived).map(row => row.thread), nextCursor: null }
    if (method === 'thread/loaded/list') return { data: [...this.records.keys()].filter(id => !this.records.get(id).archived), nextCursor: null }
    const record = this.records.get(params.threadId)
    if (!record) throw new Error('not found')
    if (['thread/read', 'thread/resume'].includes(method)) return { thread: structuredClone(record.thread), model: 'model', reasoningEffort: 'high', approvalPolicy: 'on-request' }
    if (method === 'thread/turns/list') {
      const offset = Number(params.cursor || 0), limit = params.limit || 20
      return { data: structuredClone(record.turns.slice(offset, offset + limit)), nextCursor: offset + limit < record.turns.length ? String(offset + limit) : null }
    }
    if (method === 'thread/fork') {
      const backup = structuredClone(record); backup.thread.id = 'backup'
      if (params.beforeTurnId) backup.turns = backup.turns.slice(backup.turns.findIndex(turn => turn.id === params.beforeTurnId) + 1)
      this.records.set('backup', backup)
      return { thread: backup.thread }
    }
    if (method === 'thread/settings/update') this.emit('message', { method: 'thread/settings/updated', params: { threadId: params.threadId, threadSettings: { ...params } } })
    if (method === 'thread/name/set') record.thread.name = params.name
    if (method === 'thread/revert') record.turns = record.turns.slice(record.turns.findIndex(turn => turn.id === params.beforeTurnId) + 1)
    if (method === 'thread/archive') record.archived = true
    if (method === 'thread/unarchive') record.archived = false
    return {}
  }
}
const fixture = () => { const rpc = new RPC(); return { rpc, bridge: new Bridge(rpc) } }

test('search covers paginated history, filters tool output and pages matches', async () => {
  const { rpc, bridge } = fixture()
  const record = rpc.records.get('test')
  record.turns = Array.from({ length: 61 }, (_, i) => turn('t' + i, 'needle ' + i))
  record.turns[60].items.push({ id: 'tool', type: 'commandExecution', command: 'echo', aggregatedOutput: 'unique older tool output', status: 'completed' })
  const first = await searchHistory(bridge, 'test', 'NEEDLE', 'user')
  assert.equal(first.total, 61); assert.equal(first.results.length, 50); assert.equal(first.nextOffset, 50)
  assert.equal((await searchHistory(bridge, 'test', 'needle', 'user', 50)).results.length, 11)
  const tool = await searchHistory(bridge, 'test', 'unique older', 'tool')
  assert.equal(tool.results[0].messageId, 'tool'); assert.equal(tool.results[0].turnId, 't60')
  assert.equal(rpc.calls.some(call => call.method === 'thread/resume'), false)
})

test('file changes select the last editing turn and group patches by file', async () => {
  const { rpc, bridge } = fixture()
  rpc.records.get('test').turns[1].items.push({ type: 'fileChange', status: 'completed', changes: [{ path: '/workspace/a.py', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }, { path: '/workspace/b.py', kind: { type: 'add' }, diff: 'added\n' }] })
  const result = await fileChanges(bridge, 'test')
  assert.equal(result.turnId, 't1'); assert.equal(result.files.length, 2)
  assert.equal(result.files[0].path, '/workspace/a.py')
  assert.match(result.files[1].diff, /@@ -0,0 \+1,1 @@\n\+added/)
  await assert.rejects(fileChanges(bridge, 'test', 'absent'), /no longer/)
})

test('revert saves an inert full backup before trimming history and returns the original draft', async () => {
  const { rpc, bridge } = fixture()
  const result = await revertHistory(bridge, 'test', 't2')
  assert.equal(result.draft.text, 'second'); assert.equal(result.backup.id, 'backup')
  assert.equal(rpc.records.get('backup').turns.length, 2)
  assert.deepEqual(rpc.records.get('test').turns.map(turn => turn.id), ['t1'])
  assert.equal(rpc.calls.find(call => call.method === 'thread/fork').params.deferGoalContinuation, true)
  const methods = rpc.calls.map(call => call.method)
  assert(methods.indexOf('thread/fork') < methods.indexOf('thread/revert'))
  assert.equal(methods.some(method => /fs\/|exec|apply_patch/.test(method)), false)
})

test('invalid or busy reverts never create a backup or change history; mutations block prompts', async () => {
  const { rpc, bridge } = fixture()
  await assert.rejects(revertHistory(bridge, 'test', 'absent'), /still in/)
  rpc.records.get('test').thread.status.type = 'active'
  await assert.rejects(revertHistory(bridge, 'test', 't1'), /finish/)
  assert.equal(rpc.calls.some(call => call.method === 'thread/fork'), false)
  bridge.mutations.add('test')
  await assert.rejects(bridge.prompt('test', { parts: [{ type: 'text', text: 'hello' }] }), /change is in progress/)
})

test('batch archive reports partial failure and supports restoring the successful item', async () => {
  const { rpc, bridge } = fixture()
  rpc.records.set('busy', { thread: { ...makeThread('busy'), status: { type: 'active' } }, turns: [], archived: false })
  const result = await archiveSessions(bridge, ['test', 'busy'], true)
  assert.deepEqual(result.results.map(row => row.ok), [true, false])
  assert.deepEqual((await bridge.list(true)).map(thread => thread.id), ['test'])
  assert.equal((await archiveSessions(bridge, ['test'], false)).results[0].ok, true)
  assert.equal((await bridge.list(true)).length, 0)
})

test('task status prioritizes native approval/input flags and reads failures without resuming', async () => {
  const { rpc, bridge } = fixture()
  assert.equal(taskStatus({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } }), 'approval')
  assert.equal(taskStatus({ status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }), 'input')
  rpc.records.get('test').turns[0] = { id: 'failed', status: 'failed', error: { message: 'failure example' }, items: [] }
  const result = await taskOverview(bridge)
  assert.equal(result.items[0].state, 'failed'); assert.equal(result.items[0].error, 'failure example')
  assert.equal(rpc.calls.some(call => call.method === 'thread/resume'), false)
})


test('full fork preserves source history and creates an inert branch', async () => {
  const { rpc, bridge } = fixture()
  const before = structuredClone(rpc.records.get('test'))
  const result = await forkHistory(bridge, 'test')
  assert.equal(result.sourceID, 'test'); assert.equal(result.draft, null)
  assert.match(result.session.title, /^Fork · test/)
  assert.deepEqual(rpc.records.get('test'), before)
  assert.equal(rpc.records.get('backup').turns.length, 2)
  const params = rpc.calls.find(call => call.method === 'thread/fork').params
  assert.equal(params.deferGoalContinuation, true)
  assert.equal(params.beforeTurnId, undefined)
  assert.equal(params.model, 'model'); assert.equal(params.modelProvider, 'test-provider')
  assert.equal(params.cwd, '/workspace')
  const settings = rpc.calls.find(call => call.method === 'thread/settings/update').params
  assert.equal(settings.threadId, 'backup'); assert.equal(settings.effort, 'high')
  assert.equal(settings.approvalPolicy, 'on-request')
  assert.equal(rpc.calls.some(call => ['thread/revert', 'turn/start', 'thread/archive'].includes(call.method)), false)
})

test('fork before a prompt copies only earlier turns and returns an editable draft', async () => {
  const { rpc, bridge } = fixture()
  rpc.records.get('test').turns[0].items[0].content.push({ type: 'image', url: 'data:image/jpeg;base64,YQ==' }, { type: 'localImage', path: '/file.png' })
  const result = await forkHistory(bridge, 'test', 't2')
  assert.deepEqual(rpc.records.get('backup').turns.map(turn => turn.id), ['t1'])
  assert.equal(rpc.records.get('test').turns.length, 2)
  assert.equal(result.draft.text, 'second')
  assert.deepEqual(result.draft.images, ['data:image/jpeg;base64,YQ=='])
  assert.equal(result.draft.omittedAttachments, 1)
})

test('invalid and active forks fail before creating a branch', async () => {
  const { rpc, bridge } = fixture()
  await assert.rejects(forkHistory(bridge, 'test', ''), /valid turn/)
  await assert.rejects(forkHistory(bridge, 'test', 'absent'), /still in/)
  rpc.records.get('test').thread.status.type = 'active'
  await assert.rejects(forkHistory(bridge, 'test'), /finish/)
  assert.equal(rpc.calls.some(call => call.method === 'thread/fork'), false)
})
