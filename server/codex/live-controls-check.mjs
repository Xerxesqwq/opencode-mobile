// Opt-in native integration check. Creates a dedicated thread; consumes a small model request.
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { controlOptions } from './controls.mjs'

const rpc = new CodexRPC(process.env.CODEX_SOCKET || path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
const bridge = new Bridge(rpc)
const waitFor = async (predicate, label) => {
  const end = Date.now() + 180000
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)) }
  throw new Error(`Timed out: ${label}`)
}
try {
  await rpc.connect()
  const options = await controlOptions(rpc, process.cwd())
  assert(options.models.length > 0)
  const session = await bridge.create(process.cwd(), `Codex controls test ${Math.floor(Date.now() / 1000)}`)
  const id = session.id
  console.log('Dedicated test session:', id)
  let current = await bridge.updateSettings(id, { effort: 'high' })
  assert.equal(current.codex.effort, 'high')
  console.log('PASS: reasoning effort saved and read back')
  current = await bridge.updateSettings(id, { permissions: ':read-only' })
  assert.equal(current.codex.sandboxPolicy.type, 'readOnly')
  current = await bridge.updateSettings(id, { permissions: ':workspace' })
  assert.equal(current.codex.sandboxPolicy.type, 'workspaceWrite')
  console.log('PASS: read-only/workspace permissions saved and read back')
  current = await bridge.updateSettings(id, { mode: 'plan' })
  assert.equal(current.codex.mode, 'plan')
  current = await bridge.updateSettings(id, { mode: 'default', effort: 'low' })
  assert.equal(current.codex.mode, 'default')
  console.log('PASS: plan/default modes saved and read back')
  await bridge.prompt(id, { parts: [{ type: 'text', text: 'Reply exactly CODEX_CONTROLS_OK. Do not use tools.' }] })
  await waitFor(() => bridge.threads.get(id).thread.status.type === 'idle' && bridge.threads.get(id).tokenUsage, 'reply and token usage')
  current = bridge.describe(bridge.threads.get(id).thread)
  assert(current.codex.tokenUsage.last.totalTokens > 0)
  assert(current.codex.tokenUsage.modelContextWindow > 0)
  console.log('PASS: real context usage received')
  await bridge.compact(id)
  await waitFor(() => !bridge.threads.get(id).compacting && bridge.threads.get(id).thread.status.type === 'idle', 'native compaction')
  const history = await bridge.history(id)
  assert(history.some(message => message.parts.some(part => part.text === 'Context compacted.')))
  console.log('PASS: native context compaction completed')
  // A new client recovers usage without hydrating the full conversation.
  const replayRpc = new CodexRPC(rpc.socket || process.env.CODEX_SOCKET || path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
  const replay = new Bridge(replayRpc)
  try {
    await replayRpc.connect(); await replay.attach(id)
    await waitFor(() => replay.threads.get(id)?.tokenUsage, 'usage replay')
    assert(replay.describe(replay.threads.get(id).thread).codex.tokenUsage.last.totalTokens > 0)
    console.log('PASS: context usage restored after reconnect')
  } finally { replayRpc.close() }
  if (process.env.CODEX_CONTROLS_REPORT) await writeFile(process.env.CODEX_CONTROLS_REPORT, JSON.stringify({ sessionId: id, title: session.title, checks: ['effort', 'permissions', 'mode', 'context', 'compact', 'reconnect'], models: options.models.map(model => ({ id: model.id, efforts: model.efforts.map(e => e.reasoningEffort) })), passed: true }, null, 2) + '\n')
} finally { rpc.close() }
