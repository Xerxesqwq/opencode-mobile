import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { message, messages } from './mapping.mjs'
import { readMedia, itemImages } from './media.mjs'
import { createGateway } from './http.mjs'
import { Bridge } from './bridge.mjs'
import { turnPage } from './turns.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64')
const thread = { id: 'fixture', cwd: '/workspace', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, model: 'gpt-6-luna' }
const turn = { id: 'turn', status: 'completed', items: [] }
const mapped = item => message(thread, turn, item)

test('empty reasoning and empty assistant text have no bubbles; real content and failures remain', () => {
  const items = [{ id: 'hidden', type: 'reasoning', summary: [], content: [] },
    { id: 'space', type: 'agentMessage', text: ' \n ' },
    { id: 'public', type: 'reasoning', summary: ['Checking the result'], content: [] },
    { id: 'reply', type: 'agentMessage', text: 'Done' },
    { id: 'error', type: 'commandExecution', command: 'false', status: 'failed' }]
  assert.deepEqual(messages(thread, [{ ...turn, items }]).map(row => row.info.id), ['public', 'reply', 'error'])
  const rpc = new EventEmitter(), bridge = new Bridge(rpc), events = []
  bridge.on('event', event => events.push(event))
  const state = { thread }
  bridge.emitItem(state, { ...turn, items }, items[0])
  assert.equal(events.length, 0)
  bridge.emitItem(state, { ...turn, items }, { ...items[0], summary: ['Now visible'] })
  assert.equal(events.find(event => event.type === 'message.part.updated').properties.part.text, 'Now visible')
})

test('generated and reviewed images become compact authenticated media references', () => {
  const generated = mapped({ type: 'imageGeneration', id: 'gen', status: 'completed', result: png.toString('base64').repeat(1000), savedPath: '/images/output.png', revisedPrompt: 'A drawing' })
  assert.equal(generated.parts[0].url, '/session/fixture/codex/media/gen/0')
  assert.equal(generated.parts[1].state.title, 'Generate image')
  assert(JSON.stringify(generated).length < 1500)
  const viewed = mapped({ type: 'imageView', id: 'view', path: '/workspace/a.png' })
  assert.equal(viewed.parts[0].filename, 'a.png')
  assert.equal(viewed.parts[0].url, '/session/fixture/codex/media/view/0')
  assert.equal(mapped({ type: 'imageGeneration', id: 'pending', status: 'in_progress', result: '' }).parts[0].state.status, 'running')
  assert.equal(mapped({ type: 'imageGeneration', id: 'bad', status: 'failed', result: '', failure: { message: 'Generation failed' } }).parts[0].state.error.message, 'Generation failed')
})

test('Markdown local images use item-scoped URLs, preserving titles and remote images', () => {
  const text = '![one](<assets/my image.png> "Title")\n![two](assets/a(1).png)\n![remote](https://images.example/a.png)'
  const row = mapped({ type: 'agentMessage', id: 'markdown', text })
  assert.equal(row.parts[0].text, '![one](</session/fixture/codex/media/markdown/0> "Title")\n![two](/session/fixture/codex/media/markdown/1)\n![remote](https://images.example/a.png)')
  const images = itemImages({ type: 'agentMessage', text }, thread.cwd)
  assert.equal(images[0].path, '/workspace/assets/my image.png')
  assert.equal(images[1].path, '/workspace/assets/a(1).png')
  assert.equal(images[2].kind, 'remote')
})

test('MCP, dynamic, function and user image payloads are extracted without embedding base64 in JSON', () => {
  const url = 'data:image/png;base64,' + png.toString('base64')
  const variants = [
    { type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] } },
    { type: 'dynamicToolCall', contentItems: [{ type: 'inputImage', imageUrl: url }] },
    { type: 'functionCallOutput', output: [{ type: 'input_image', image_url: url }] },
    { type: 'userMessage', content: [{ type: 'image', url }, { type: 'localImage', path: '/workspace/attached.png' }] },
  ]
  for (const item of variants) {
    const row = mapped({ ...item, id: 'image' })
    assert(row.parts.some(part => part.type === 'file'))
    assert(!JSON.stringify(row).includes(png.toString('base64')))
  }
})

test('binary media routes require auth and serve only raster images referenced by the requested item', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-media-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'image.png'), png)
  await writeFile(path.join(dir, 'secret.png'), 'not an image')
  const items = [
    { type: 'imageView', id: 'view', path: path.join(dir, 'image.png') },
    { type: 'imageView', id: 'not-image', path: path.join(dir, 'secret.png') },
    { type: 'imageView', id: 'missing', path: path.join(dir, 'missing.png') },
    { type: 'imageGeneration', id: 'fallback', result: png.toString('base64'), savedPath: path.join(dir, 'removed.png') },
    { type: 'commandExecution', id: 'command', command: 'cat secret.png' },
  ]
  const bridge = new EventEmitter()
  bridge.threads = new Map([['fixture', { thread, turns: new Map([['turn', { ...turn, items }]]) }]])
  bridge.rpc = { connect: async () => ({}), call: async () => { throw Object.assign(new Error('No such item'), { status: 404 }) } }
  const password = randomBytes(24).toString('base64')
  const server = createGateway({ bridge, password })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/session/fixture/codex/media/`
  const headers = { Authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}` }
  assert.equal((await fetch(base + 'view/0')).status, 401)
  assert.equal((await fetch(base + 'view/0', { headers: { ...headers, Origin: 'https://other.example' } })).status, 403)
  const good = await fetch(base + 'view/0?path=/etc/passwd', { headers })
  assert.equal(good.status, 200)
  assert.equal(good.headers.get('content-type'), 'image/png')
  assert.equal(good.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), png)
  const fallback = await fetch(base + 'fallback/0', { headers })
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), png)
  for (const [suffix, status] of [['view/1', 404], ['not-image/0', 415], ['missing/0', 404], ['command/0', 404], ['view/-1', 400], ['%2e%2e%2fsecret/0', 404]]) {
    assert.equal((await fetch(base + suffix, { headers })).status, status, suffix)
  }
})

test('uncached media follows item pagination without resuming or running the thread', async () => {
  const calls = []
  const bridge = { threads: new Map(), rpc: { call: async (method, params) => {
    calls.push(method)
    if (method === 'thread/read') return { thread }
    assert.equal(method, 'thread/items/list')
    return params.cursor ? { data: [{ item: { type: 'imageGeneration', id: 'found', result: png.toString('base64') } }] }
      : { data: [{ item: { type: 'reasoning', id: 'empty', summary: [] } }], nextCursor: 'next' }
  } } }
  assert.deepEqual((await readMedia(bridge, 'fixture', 'found', '0')).bytes, png)
  assert.deepEqual(calls, ['thread/read', 'thread/items/list', 'thread/items/list'])
})

test('image-heavy turns page through items instead of requesting one giant full turn', async () => {
  const calls = [], rpc = { call: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', itemsView: 'notLoaded', items: [] }], nextCursor: 'older-turn' }
    return params.cursor ? { data: [{ item: { id: 'b' } }], nextCursor: null } : { data: [{ item: { id: 'a' } }], nextCursor: 'older-item' }
  } }
  const page = await turnPage(rpc, { threadId: 'fixture', limit: 1 })
  assert.equal(calls[0].params.itemsView, 'notLoaded')
  assert.equal(calls[1].params.limit, 8)
  assert.deepEqual(page.data[0].items.map(item => item.id), ['a', 'b'])
  assert.equal(page.nextCursor, 'older-turn')
})
