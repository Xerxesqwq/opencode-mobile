import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const expo = createRequire(require.resolve('expo/package.json'))
const metro = createRequire(expo.resolve('@expo/metro-config/package.json'))
const postcss = metro('postcss')
const plugin = { postcssPlugin: 'compatibility-test', Declaration(declaration) { declaration.value = 'blue' } }

test('scoped PostCSS override retains Expo Metro CommonJS/default plugin API', async () => {
  const result = await postcss.default([plugin]).process('a { color: red }', { from: 'input.css', map: false })
  assert.equal(result.css, 'a { color: blue }')
  assert.equal(result.map, undefined)
})

test('scoped PostCSS override still generates and consumes explicit source maps', async () => {
  const first = await postcss.default([plugin]).process('a { color: red }', { from: 'input.css', to: 'output.css', map: { inline: false } })
  assert.deepEqual(first.map.toJSON().sources, ['input.css'])
  const second = await postcss.default([]).process(first.css, { from: 'output.css', to: 'final.css', map: { prev: first.map.toJSON(), inline: false } })
  assert.deepEqual(second.map.toJSON().sources, ['input.css'])
  assert.match(second.css, /color: blue/)
})

test('patched nanoid retains native navigation default ID behavior', () => {
  const { nanoid } = require('nanoid/non-secure')
  const values = Array.from({ length: 20 }, () => nanoid())
  assert.ok(values.every((value) => value.length === 21))
  assert.equal(new Set(values).size, values.length)
})
