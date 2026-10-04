import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

// One connection to the existing daemon. Closing this socket never stops Codex.
export class CodexRPC extends EventEmitter {
  constructor(socket, timeout = 25000) {
    super()
    this.socket = socket
    this.timeout = timeout
    this.pending = new Map()
    this.sequence = 0
  }

  async connect() {
    if (this.ready) return this.ready
    this.ready = this.open().catch(error => { this.ready = null; throw error })
    return this.ready
  }

  async open() {
    const ws = new WebSocket(`ws+unix://${this.socket}:/rpc`, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 })
    this.ws = ws
    ws.on('message', data => {
      try { this.receive(JSON.parse(data.toString())) }
      catch { ws.close(1002, 'Invalid JSON RPC') }
    })
    ws.on('error', () => {}) // open and close handlers propagate transport failures
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ready = null
      for (const request of this.pending.values()) request.reject(new Error('Codex disconnected; reconnect before retrying'))
      this.pending.clear()
      this.emit('disconnect')
    })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const result = await this.call('initialize', {
      clientInfo: { name: 'opencode_mobile', title: 'OpenCode Mobile', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
    return result
  }

  receive(message) {
    if (message.method) { this.emit('message', message); return }
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.error) { request.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); return }
    request.resolve(message.result)
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Codex is disconnected')
    this.ws.send(JSON.stringify(message))
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; check the session before retrying`)) }, this.timeout)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try { this.send({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  reply(id, result) { this.send({ id, result }) }
  close() { this.ws?.close() }
}
