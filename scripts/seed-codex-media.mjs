// Opt-in Android fixture. One Luna turn views a local test image and emits Markdown.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'
import { CodexRPC } from '../server/codex/rpc.mjs'

const cwd = process.env.CODEX_MEDIA_FIXTURE_DIR, report = process.env.CODEX_MEDIA_FIXTURE
assert(cwd && path.isAbsolute(cwd) && report, 'Set an absolute CODEX_MEDIA_FIXTURE_DIR and CODEX_MEDIA_FIXTURE report path')
await mkdir(cwd, { recursive: true })
await sharp(Buffer.from('<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#8b5cf6"/><circle cx="200" cy="225" r="120" fill="#facc15"/><rect x="400" y="130" width="240" height="190" fill="#38bdf8"/></svg>')).png().toFile(path.join(cwd, 'preview.png'))
const rpc = new CodexRPC(path.join(homedir(), '.codex/app-server-control/app-server-control.sock'))
await rpc.connect()
let id, passed = false
try {
  const model = 'gpt-6-luna', title = `Media UI check ${Date.now()}`
  const result = await rpc.call('thread/start', { cwd, model, approvalPolicy: 'on-request', sandbox: 'read-only' })
  id = result.thread.id
  await rpc.call('thread/name/set', { threadId: id, name: title })
  await rpc.call('thread/settings/update', { threadId: id, model, effort: 'low', serviceTier: null })
  const done = new Map()
  rpc.on('message', packet => { if (packet.method === 'turn/completed' && packet.params.threadId === id) done.set(packet.params.turn.id, packet.params.turn) })
  const { turn } = await rpc.call('turn/start', { threadId: id, model, input: [{ type: 'text', text: `Use view_image once on ${cwd}/preview.png. This is a display test: do not create or modify files. Then reply exactly with these lines, preserving Markdown:\nMEDIA_MARKDOWN_OK\n\n![Preview](preview.png)\n\nMEDIA_MISSING\n\n![Missing image](missing.png)`, text_elements: [] }] })
  const deadline = Date.now() + 120000
  while (!done.has(turn.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(done.get(turn.id)?.status, 'completed')
  const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: true })
  assert.equal(thread.model, model)
  assert(thread.turns.some(turn => turn.items.some(item => item.type === 'imageView')))
  await writeFile(report, JSON.stringify({ id, title, cwd, model }, null, 2) + '\n')
  passed = true
  console.log('Luna media fixture ready; delete the report’s exact thread after Android verification.')
} finally {
  if (id && !passed) await rpc.call('thread/delete', { threadId: id })
  rpc.close()
}
