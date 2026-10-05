import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { CodexRPC } from './rpc.mjs'
import { Bridge } from './bridge.mjs'
import { createGateway } from './http.mjs'

test('real Unix WebSocket RPC → authenticated HTTP/SSE → approval response; reconnect reinitializes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-gateway-test-'))
  const socket = path.join(directory, 'rpc.sock')
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const received = []
  let peer
  wss.on('connection', ws => {
    peer = ws
    ws.on('message', bytes => {
      const packet = JSON.parse(bytes)
      received.push(packet)
      if (packet.method === 'initialize') ws.send(JSON.stringify({ id: packet.id, result: { userAgent: 'Codex/0.160.0' } }))
      if (packet.method === 'test/error') ws.send(JSON.stringify({ id: packet.id, error: { code: -32602, message: 'Bad input' } }))
    })
  })
  await new Promise(resolve => server.listen(socket, resolve))
  const rpc = new CodexRPC(socket, 1000)
  const bridge = new Bridge(rpc)
  const password = 'integration-test-password-1234'
  const gateway = createGateway({ bridge, password })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => { rpc.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); gateway.closeAllConnections(); gateway.close(); await rm(directory, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${gateway.address().port}`
  const headers = { Authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}` }
  const abort = new AbortController()
  const stream = await fetch(url + '/global/event', { headers, signal: abort.signal })
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /server.connected/)
  assert.equal(received[0].method, 'initialize')
  peer.send(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', itemId: 'cmd1', command: 'echo test' } }))
  const event = new TextDecoder().decode((await reader.read()).value)
  assert.match(event, /permission.asked/)
  // Drop only the mobile stream: the pending request remains available.
  abort.abort()
  const pending = await (await fetch(url + '/permission', { headers })).json()
  assert.equal(pending.length, 1)
  const response = await fetch(url + `/permission/${pending[0].id}/reply`, { method: 'POST', headers, body: JSON.stringify({ reply: 'reject' }) })
  assert.equal(response.status, 200)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received.find(p => p.id === 'approval'), { id: 'approval', result: { decision: 'decline' } })
  await assert.rejects(rpc.call('test/error'), /Bad input/)
  const disconnected = once(rpc, 'disconnect'); peer.close(); await disconnected
  await rpc.connect()
  assert.equal(received.filter(p => p.method === 'initialize').length, 2)
})
