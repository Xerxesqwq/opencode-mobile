import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Bridge } from './bridge.mjs'
import { settingsPatch, controlOptions } from './controls.mjs'

class RPC extends EventEmitter {
  calls = []
  settings = { model: 'large', reasoningEffort: 'ultra', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, instructionSources: ['/workspace/AGENTS.md'] }
  async call(method, params) {
    this.calls.push({ method, params })
    if (method === 'model/list') return { data: ['large', 'small'].map(model => ({ model, displayName: model, serviceTiers: model === 'large' ? [{ id: 'priority', name: 'Fast', description: 'Faster' }] : [], defaultReasoningEffort: 'medium', supportedReasoningEfforts: (model === 'large' ? ['medium', 'high', 'ultra'] : ['medium', 'high']).map(reasoningEffort => ({ reasoningEffort })) })) }
    if (method === 'permissionProfile/list') return { data: [{ id: ':read-only', allowed: true }, { id: ':danger-full-access', allowed: false }] }
    if (method === 'configRequirements/read') return { requirements: { allowedApprovalPolicies: ['on-request'] } }
    if (method === 'collaborationMode/list') return { data: [{ mode: 'plan' }, { mode: 'default' }] }
    if (method === 'thread/resume') return { ...this.settings, thread: { id: 'test', cwd: '/workspace', model: null, status: { type: 'idle' }, createdAt: 1, updatedAt: 2 } }
    if (method === 'thread/turns/list') return { data: [] }
    if (method === 'thread/settings/update') {
      if ('effort' in params) this.settings.reasoningEffort = params.effort
      if ('serviceTier' in params) this.settings.serviceTier = params.serviceTier ?? 'default'
      this.emit('message', { method: 'thread/settings/updated', params: { threadId: 'test', threadSettings: { model: this.settings.model, effort: this.settings.reasoningEffort, serviceTier: this.settings.serviceTier } } })
      return {}
    }
    return {}
  }
}

const fixture = async () => { const rpc = new RPC(); const bridge = new Bridge(rpc); const state = await bridge.attach('test'); return { rpc, bridge, state } }

test('validates reasoning levels, preserves compatible effort and chooses model default when needed', async () => {
  const { rpc, state } = await fixture()
  assert.deepEqual(await settingsPatch(rpc, state, { model: 'small' }), { threadId: 'test', model: 'small', effort: 'medium' })
  assert.deepEqual(await settingsPatch(rpc, state, { model: 'large' }), { threadId: 'test', model: 'large' })
  await assert.rejects(settingsPatch(rpc, state, { model: 'small', effort: 'ultra' }), /not supported/)
  assert.equal((await settingsPatch(rpc, state, { effort: 'default' })).effort, 'medium')
  await assert.rejects(settingsPatch(rpc, state, { effort: null }), /not supported/)
  await assert.rejects(settingsPatch(rpc, state, null), /object/)
})

test('enforces permission restrictions and sends only requested settings', async () => {
  const { rpc, state } = await fixture()
  assert.deepEqual(await settingsPatch(rpc, state, { permissions: ':read-only' }), { threadId: 'test', permissions: ':read-only' })
  await assert.rejects(settingsPatch(rpc, state, { permissions: ':danger-full-access' }), /restricted/)
  await assert.rejects(settingsPatch(rpc, state, { approvalPolicy: 'never' }), /restricted/)
  const plan = await settingsPatch(rpc, state, { mode: 'plan' })
  assert.deepEqual(plan.collaborationMode, { mode: 'plan', settings: { model: 'large', reasoning_effort: 'ultra', developer_instructions: null } })
  assert.equal(plan.approvalPolicy, undefined)
})

test('returns effective settings confirmed by the native update notification', async () => {
  const { rpc, bridge } = await fixture()
  const session = await bridge.updateSettings('test', { effort: 'high' })
  assert.equal(session.codex.effort, 'high')
  assert.equal(session.codex.model, 'large')
  assert.deepEqual(rpc.calls.at(-1), { method: 'thread/settings/update', params: { threadId: 'test', effort: 'high' } })
})

test('keeps usage replayed before resume, merges settings and clears cached state on disconnect', async () => {
  const rpc = new RPC(), bridge = new Bridge(rpc)
  const usage = { last: { totalTokens: 200 }, total: { totalTokens: 800 }, modelContextWindow: 1000 }
  bridge.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'test', tokenUsage: usage } })
  bridge.receive({ method: 'thread/settings/updated', params: { threadId: 'test', threadSettings: { effort: 'high', model: 'large' } } })
  const state = await bridge.attach('test')
  const session = bridge.describe(state.thread)
  assert.deepEqual(session.codex.tokenUsage, usage)
  assert.deepEqual(session.codex.instructionSources, ['/workspace/AGENTS.md'])
  assert.equal(session.codex.effort, 'high')
  rpc.emit('disconnect')
  assert.equal(bridge.observed.size, 0)
  assert.equal(bridge.threads.size, 0)
})

test('compact rejects active work and follows native completion; failed RPC releases the busy flag', async () => {
  const { rpc, bridge, state } = await fixture()
  state.thread.status.type = 'active'
  await assert.rejects(bridge.compact('test'), /finish/)
  state.thread.status.type = 'idle'
  assert.equal((await bridge.compact('test')).codex.compacting, true)
  await assert.rejects(bridge.compact('test'), /finish/)
  bridge.receive({ method: 'turn/completed', params: { threadId: 'test', turn: { id: 'compact', status: 'completed', items: [] } } })
  assert.equal(bridge.describe(state.thread).codex.compacting, false)
  const original = rpc.call.bind(rpc)
  rpc.call = (method, params) => method === 'thread/compact/start' ? Promise.reject(new Error('native failure')) : original(method, params)
  await assert.rejects(bridge.compact('test'), /native failure/)
  assert.equal(state.compacting, false)
})

test('hydrates the last turn file diff', async () => {
  const { bridge, state } = await fixture()
  state.turns.set('edit', { items: [{ type: 'fileChange', changes: [{ path: '/workspace/a.txt', diff: '+new' }] }] })
  assert.equal(await bridge.diff('test'), '/workspace/a.txt\n+new')
})

test('Fast tier follows the catalog; null explicitly disables it and other patches preserve it', async () => {
  const { rpc, state } = await fixture()
  const options = await controlOptions(rpc, '/workspace')
  assert.equal(options.models[0].serviceTiers[0].id, 'priority')
  assert.deepEqual(await settingsPatch(rpc, state, { serviceTier: 'priority' }), { threadId: 'test', serviceTier: 'priority' })
  state.settings.serviceTier = 'priority'
  assert.deepEqual(await settingsPatch(rpc, state, { serviceTier: null }), { threadId: 'test', serviceTier: null })
  assert.equal(Object.hasOwn(await settingsPatch(rpc, state, { effort: 'high' }), 'serviceTier'), false)
  assert.equal((await settingsPatch(rpc, state, { model: 'small' })).serviceTier, null)
  assert.equal(Object.hasOwn(await settingsPatch(rpc, state, { model: 'large' }), 'serviceTier'), false)
  for (const serviceTier of ['fast', 'ultrafast', '', false, 1]) {
    await assert.rejects(settingsPatch(rpc, state, { serviceTier }), /not supported/)
  }
  await assert.rejects(settingsPatch(rpc, state, { model: 'small', serviceTier: 'priority' }), /not supported/)
  state.thread.model = 'small'; state.settings.model = 'small'
  assert.equal((await settingsPatch(rpc, state, { serviceTier: null })).serviceTier, null)
})

test('native tier confirmation preserves effort and can clear a previous Fast selection', async () => {
  const { bridge } = await fixture()
  const fast = await bridge.updateSettings('test', { serviceTier: 'priority' })
  assert.equal(fast.codex.serviceTier, 'priority')
  assert.equal(fast.codex.effort, 'ultra')
  const standard = await bridge.updateSettings('test', { serviceTier: null })
  assert.equal(standard.codex.serviceTier, 'default')
  assert.equal(standard.codex.effort, 'ultra')
})
