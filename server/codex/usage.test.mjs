import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { restoredUsage } from './usage.mjs'

test('reads the latest valid usage snapshot and excludes message contents and external paths', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = total => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { total_tokens: total, input_tokens: 100, cached_input_tokens: 60 },
    total_token_usage: { total_tokens: 800 }, model_context_window: 1000,
  } } })
  const file = path.join(root, 'rollout.jsonl')
  await writeFile(file, [record(150), '{"type":"message","secret":"private text"}', record(200), '{partial'].join('\n'))
  const usage = await restoredUsage(file, root)
  assert.equal(usage.last.totalTokens, 200)
  assert.equal(usage.last.cachedInputTokens, 60)
  assert.equal(usage.total.totalTokens, 800)
  assert(!JSON.stringify(usage).includes('private'))
  assert.equal(await restoredUsage(file, path.join(root, 'missing')), null)
  const link = path.join(root, 'external.jsonl')
  await symlink('/etc/passwd', link)
  assert.equal(await restoredUsage(link, root), null)
})
