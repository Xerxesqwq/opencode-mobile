import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeAudit } from './summarize-npm-audit.mjs'

const report = (counts) => ({ metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 0, info: 0, total: 3, ...counts } } })

test('audit summary preserves advisory counts without claiming APK exposure', () => {
  assert.match(summarizeAudit(report(), 'Full graph'), /critical: 0 \| high: 2 \| moderate: 1/)
})

test('audit summary accepts an actually clean report', () => {
  assert.match(summarizeAudit(report({ high: 0, moderate: 0, total: 0 }), 'Full graph'), /total: 0/)
})

test('audit summary rejects registry errors instead of reporting zero', () => {
  assert.throws(() => summarizeAudit({ error: { code: 'ENETUNREACH' } }, 'Full graph'), /not a clean result/)
})

test('audit summary rejects missing or invalid counts', () => {
  for (const value of [undefined, -1, '2', 1.5]) {
    assert.throws(() => summarizeAudit(report({ high: value }), 'Full graph'), /not a clean result/)
  }
})
