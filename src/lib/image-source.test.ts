import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageSource } from './image-source.ts'
import { hasMessageContent } from './message-content.ts'
import type { Message, Part } from './sdk'

test('image credentials are attached only to gateway media routes', () => {
  const headers = { Authorization: 'Basic test' }, base = 'https://gateway.example:14096/'
  const route = '/session/session-1/codex/media/item-1/0'
  assert.deepEqual(imageSource(base, headers, route), { uri: base.slice(0, -1) + route, headers })
  for (const uri of ['https://other.example/a.png', 'data:image/png;base64,aA==', 'https://gateway.example:14096.evil.example/a.png']) {
    assert.deepEqual(imageSource(base, headers, uri), { uri })
  }
  for (const uri of ['//other.example/a.png', '/etc/passwd', '/session/x/codex/media/../../a/0', 'javascript:alert(1)']) {
    assert.equal(imageSource(base, headers, uri), undefined)
  }
})

test('streaming metadata and empty reasoning stay hidden until displayable content arrives', () => {
  const message: Message = { id: 'a', sessionID: 's', role: 'assistant', time: { created: 1 } }
  const part = (value: Partial<Part>): Part => ({ id: 'p', messageID: 'a', type: 'text', ...value })
  assert.equal(hasMessageContent(message, []), false)
  assert.equal(hasMessageContent(message, [part({ type: 'reasoning', text: '  \n' })]), false)
  assert.equal(hasMessageContent(message, [part({ type: 'step-start' })]), false)
  assert.equal(hasMessageContent(message, [part({ text: 'Reply arrived' })]), true)
  assert.equal(hasMessageContent(message, [part({ type: 'file', mime: 'image/png', url: '/session/s/codex/media/i/0' })]), true)
  assert.equal(hasMessageContent(message, [part({ type: 'tool', state: { status: 'running' } })]), true)
  assert.equal(hasMessageContent({ ...message, error: { message: 'Request failed' } }, []), true)
})
