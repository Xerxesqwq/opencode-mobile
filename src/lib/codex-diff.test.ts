import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatch, foldPatch, codeTokens } from './codex-diff.ts'

test('unified patch line numbers handle additions, deletions and multiple hunks', () => {
  const rows = parsePatch('--- a/test.py\n+++ b/test.py\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n@@ -10 +11 @@\n-last\n+end\n')
  assert.deepEqual(rows.filter(row => row.kind === 'add').map(row => row.newLine), [3, 4, 11])
  assert.deepEqual(rows.filter(row => row.kind === 'remove').map(row => row.oldLine), [3, 10])
  assert.equal(rows[0].kind, 'meta')
})

test('long context collapses and expands without losing line numbers', () => {
  const rows = parsePatch('@@ -1,20 +1,20 @@\n' + Array.from({ length: 20 }, (_, i) => ' line ' + i).join('\n'))
  const folded = foldPatch(rows)
  assert.equal(folded.length, 8)
  assert.deepEqual(folded.find(row => row.kind === 'fold'), { kind: 'fold', index: 1, count: 14 })
  assert.equal(foldPatch(rows, new Set([1])).length, 21)
})

test('highlighting keeps original text and handles comment markers in strings', () => {
  const code = 'const url = "https://example.com"; // comment'
  const tokens = codeTokens(code, 'a.ts')
  assert.equal(tokens.map(token => token.text).join(''), code)
  assert.equal(tokens.find(token => token.text === '"https://example.com"')?.color, '#198754')
  assert.equal(codeTokens('# hello', 'a.py')[0].color, '#768390')
})
