import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexContextUsage, codexError, type CodexTokenCounts } from './codex.ts'

test('context uses the last request total without counting cached and reasoning tokens twice', () => {
  const last: CodexTokenCounts = { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 700, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 150 }
  assert.deepEqual(codexContextUsage({ last, total: { ...last, totalTokens: 5000 }, modelContextWindow: 10000 }), { used: 1200, limit: 10000, percent: 12 })
  assert.deepEqual(codexContextUsage({ last, total: last, modelContextWindow: null }), { used: 1200, limit: null, percent: null })
  assert.equal(codexContextUsage(null), null)
})

test('gateway errors expose the actionable message', () => {
  assert.equal(codexError(new Error('HTTP 409: {"error":"Wait for the current turn"}')), 'Wait for the current turn')
  assert.equal(codexError(new Error('Connection closed')), 'Connection closed')
})
