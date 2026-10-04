import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { input, message, messages, session } from './mapping.mjs'

export class Bridge extends EventEmitter {
  constructor(rpc) {
    super()
    this.rpc = rpc
    this.threads = new Map()
    this.pending = new Map()
    this.attaching = new Map()
    this.updates = new Map()
    rpc.on('message', data => this.receive(data))
    rpc.on('disconnect', () => {
      this.threads.clear(); this.pending.clear(); this.attaching.clear()
      for (const timer of this.updates.values()) clearTimeout(timer)
      this.updates.clear()
      this.emit('disconnect')
    })
  }

  event(type, properties) { this.emit('event', { type, properties }) }
  status(id, status) { this.event('session.status', { sessionID: id, status: { type: status === 'active' ? 'busy' : 'idle' } }) }

  async list() {
    const rows = []
    const seen = new Set()
    for (let cursor; ;) {
      const page = await this.rpc.call('thread/list', { cursor, limit: 100, sortKey: 'updated_at', modelProviders: [] })
      rows.push(...page.data)
      if (!page.nextCursor || seen.has(page.nextCursor)) break
      seen.add(page.nextCursor); cursor = page.nextCursor
    }
    // Empty threads are loaded in the daemon before a rollout is persisted.
    // Include them so a newly created session survives refreshing the list.
    const byId = new Map(rows.map(thread => [thread.id, thread]))
    const loadedCursors = new Set()
    for (let cursor; ;) {
      const page = await this.rpc.call('thread/loaded/list', { cursor, limit: 100 })
      for (const id of page.data) {
        if (byId.has(id)) continue
        try {
          const { thread } = await this.rpc.call('thread/read', { threadId: id, includeTurns: false })
          byId.set(id, thread)
        } catch (error) {
          // A loaded thread can close between listing and reading its metadata.
          if (!/not found|not loaded/i.test(error.message)) throw error
        }
      }
      if (!page.nextCursor || loadedCursors.has(page.nextCursor)) break
      loadedCursors.add(page.nextCursor); cursor = page.nextCursor
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async attach(id) {
    if (this.threads.has(id)) return this.threads.get(id)
    if (this.attaching.has(id)) return this.attaching.get(id)
    const pending = this.hydrate(id).finally(() => this.attaching.delete(id))
    this.attaching.set(id, pending)
    return pending
  }

  async hydrate(id) {
    // No permission/model overrides: preserve the live session's settings.
    const result = await this.rpc.call('thread/resume', { threadId: id, excludeTurns: true })
    const thread = result.thread
    // Register before fetching history so live events are retained during hydration.
    const state = { thread, turns: new Map(), diffs: '', live: new Map() }
    this.threads.set(id, state)
    try {
      const page = await this.rpc.call('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'full' })
      const live = state.turns
      state.turns = new Map(page.data.reverse().map(turn => [turn.id, turn]))
      for (const [turnId, turn] of live) {
        const stored = state.turns.get(turnId)
        state.turns.set(turnId, { ...stored, ...turn, items: [...new Map([...(stored?.items || []), ...turn.items].map(item => [item.id, item])).values()] })
      }
      this.status(id, thread.status.type)
      return state
    } catch (error) { this.threads.delete(id); throw error }
  }

  async history(id, limit) {
    const state = await this.attach(id)
    const turns = []
    const seen = new Set()
    for (let cursor; ;) {
      const page = await this.rpc.call('thread/turns/list', { threadId: id, cursor, limit: 20, sortDirection: 'desc', itemsView: 'full' })
      turns.push(...page.data)
      if (limit && turns.reduce((n, turn) => n + turn.items.length, 0) >= limit) break
      if (!page.nextCursor || seen.has(page.nextCursor)) break
      seen.add(page.nextCursor); cursor = page.nextCursor
    }
    // Completed history is authoritative, including user input that was not
    // included in the daemon's incremental item notifications.
    for (const turn of turns) {
      if (turn.status !== 'inProgress' || !state.turns.has(turn.id)) state.turns.set(turn.id, turn)
    }
    const result = messages(state.thread, turns.reverse())
    return limit ? result.slice(-limit) : result
  }

  async create(cwd, title) {
    const result = await this.rpc.call('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    if (title) { await this.rpc.call('thread/name/set', { threadId: result.thread.id, name: title }); result.thread.name = title }
    this.threads.set(result.thread.id, { thread: result.thread, turns: new Map(), diffs: '' })
    this.event('session.created', { info: session(result.thread) })
    return session(result.thread)
  }

  async prompt(id, body) {
    const content = input(body.parts)
    const state = await this.attach(id)
    if (state.thread.canAcceptDirectInput === false) throw Object.assign(new Error('This thread does not accept direct input'), { status: 409 })
    const active = [...state.turns.values()].find(turn => turn.status === 'inProgress')
    const clientUserMessageId = randomUUID()
    const params = { threadId: id, input: content, clientUserMessageId }
    if (body.model) {
      if (body.model.providerID !== 'codex') throw Object.assign(new Error('Select a Codex model'), { status: 400 })
      params.model = body.model.modelID
    }
    if (body.variant) params.effort = body.variant
    const result = active
      ? await this.rpc.call('turn/steer', { threadId: id, expectedTurnId: active.id, input: content, clientUserMessageId })
      : await this.rpc.call('turn/start', params)
    if (active) {
      const item = { id: clientUserMessageId, clientId: clientUserMessageId, type: 'userMessage', content }
      active.items.push(item); this.emitItem(state, active, item)
      return result
    }
    // The started notification can arrive before this response.
    if (!state.turns.has(result.turn.id)) state.turns.set(result.turn.id, result.turn)
    const turn = state.turns.get(result.turn.id)
    const item = { id: clientUserMessageId, clientId: clientUserMessageId, type: 'userMessage', content }
    if (!turn.items.some(row => row.clientId === clientUserMessageId)) turn.items.unshift(item)
    this.emitItem(state, turn, item)
    return result
  }

  async abort(id) {
    const state = await this.attach(id)
    const turn = [...state.turns.values()].find(turn => turn.status === 'inProgress')
    if (turn) await this.rpc.call('turn/interrupt', { threadId: id, turnId: turn.id })
    return true
  }

  emitItem(state, turn, item) {
    const key = `${state.thread.id}/${item.id}`
    clearTimeout(this.updates.get(key))
    this.updates.delete(key)
    const mapped = message(state.thread, turn, item, turn.items.findIndex(row => row.id === item.id))
    this.event('message.updated', { info: mapped.info })
    for (const part of mapped.parts) this.event('message.part.updated', { part })
  }

  receive(packet) {
    const { method, params: p = {} } = packet
    if (packet.id !== undefined) { this.request(packet); return }
    if (method === 'serverRequest/resolved') {
      for (const [key, request] of this.pending) if (request.packet.id === p.requestId) this.resolve(key)
      return
    }
    if (method === 'thread/started') { this.event('session.created', { info: session(p.thread) }); return }
    if (['thread/closed', 'thread/deleted', 'thread/reverted'].includes(method)) {
      this.threads.delete(p.threadId)
      this.status(p.threadId, 'idle')
      return
    }
    const state = this.threads.get(p.threadId)
    if (method === 'thread/status/changed') {
      if (state) state.thread.status = p.status
      this.status(p.threadId, p.status.type); return
    }
    if (!state) return
    if (method === 'thread/name/updated') { state.thread.name = p.threadName; this.event('session.updated', { info: session(state.thread) }); return }
    if (method === 'turn/started' || method === 'turn/completed') {
      const previous = state.turns.get(p.turn.id)
      const turn = { ...p.turn, items: p.turn.items?.length ? p.turn.items : previous?.items || [] }
      state.turns.set(turn.id, turn)
      state.thread.status = { type: method === 'turn/started' ? 'active' : 'idle' }
      state.thread.updatedAt = Math.floor(Date.now() / 1000)
      for (const item of turn.items) this.emitItem(state, turn, item)
      if (turn.error) this.event('session.error', { sessionID: p.threadId, error: { message: turn.error.message } })
      this.event('session.updated', { info: session(state.thread) })
      this.status(p.threadId, method === 'turn/started' ? 'active' : 'idle')
      return
    }
    if (method === 'turn/diff/updated') { state.diffs = p.diff; return }
    if (method === 'error') { this.event('session.error', { sessionID: p.threadId, error: p.error }); return }
    if (!p.turnId) return
    const turn = state.turns.get(p.turnId) || { id: p.turnId, status: 'inProgress', startedAt: Date.now() / 1000, items: [] }
    state.turns.set(turn.id, turn)
    if (method === 'item/started' || method === 'item/completed') {
      const index = turn.items.findIndex(item => item.id === p.item.id)
      if (index < 0) turn.items.push(p.item)
      if (index >= 0) turn.items[index] = p.item
      this.emitItem(state, turn, p.item); return
    }
    const item = turn.items.find(row => row.id === p.itemId)
    if (!item) return
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') item.text = (item.text || '') + p.delta
    if (method === 'item/commandExecution/outputDelta') item.aggregatedOutput = (item.aggregatedOutput || '') + p.delta
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const field = method.includes('summary') ? 'summary' : 'content'
      const index = p.summaryIndex ?? p.contentIndex ?? 0
      item[field] ||= []; item[field][index] = (item[field][index] || '') + p.delta
    }
    const supported = ['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta']
    if (!supported.includes(method)) return
    // Full-part snapshots match the mobile protocol; coalesce token bursts to
    // avoid flooding a mobile connection with repeated growing text payloads.
    const key = `${state.thread.id}/${item.id}`
    if (!this.updates.has(key)) this.updates.set(key, setTimeout(() => this.emitItem(state, turn, item), 50))
  }

  request(packet) {
    const p = packet.params
    if (packet.method === 'currentTime/read') { this.rpc.reply(packet.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return }
    const known = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']
    // Other clients may own dynamic tools or login refresh. Never race them by
    // answering requests we cannot fulfill. The original owner remains connected.
    if (!known.includes(packet.method)) {
      if (p.threadId) this.event('session.error', { sessionID: p.threadId, error: { message: `${packet.method} requires the original Codex client` } })
      return
    }
    if ([...this.pending.values()].some(row => row.packet.id === packet.id)) return
    const id = randomUUID()
    const question = packet.method === 'item/tool/requestUserInput'
    const value = question ? { id, sessionID: p.threadId, questions: p.questions.map(q => ({ header: q.header, question: q.question, options: q.options || [], custom: !q.isSecret })) }
      : { id, sessionID: p.threadId, permission: packet.method.split('/')[1], patterns: [p.command || p.reason || p.itemId, ...(p.permissions ? [JSON.stringify(p.permissions)] : [])], metadata: { cwd: p.cwd, reason: p.reason } }
    this.pending.set(id, { packet, value, question })
    this.event(question ? 'question.asked' : 'permission.asked', value)
  }

  resolve(id) {
    const row = this.pending.get(id)
    if (!row) return
    this.pending.delete(id)
    this.event(row.question ? 'question.replied' : 'permission.replied', { sessionID: row.value.sessionID, requestID: id })
  }

  reply(id, body, question, reject = false) {
    const row = this.pending.get(id)
    if (!row || row.question !== question) throw Object.assign(new Error('Request already resolved; refresh the session'), { status: 409 })
    const p = row.packet.params
    if (question) {
      if (!reject && (!Array.isArray(body.answers) || body.answers.length !== p.questions.length || body.answers.some(a => !Array.isArray(a) || a.some(v => typeof v !== 'string')))) throw Object.assign(new Error('Answer every question'), { status: 400 })
      this.rpc.reply(row.packet.id, { answers: Object.fromEntries(p.questions.map((q, n) => [q.id, { answers: reject ? [] : body.answers[n] }])) })
      this.resolve(id); return true
    }
    if (!['once', 'always', 'reject'].includes(body.reply)) throw Object.assign(new Error('Invalid approval decision'), { status: 400 })
    if (row.packet.method === 'item/permissions/requestApproval') {
      this.rpc.reply(row.packet.id, { permissions: body.reply === 'reject' ? {} : p.permissions, scope: body.reply === 'always' ? 'session' : 'turn' })
      this.resolve(id); return true
    }
    const decision = { once: 'accept', always: 'acceptForSession', reject: 'decline' }[body.reply]
    if (p.availableDecisions && !p.availableDecisions.includes(decision)) throw Object.assign(new Error('This approval does not offer that decision; choose another option'), { status: 400 })
    this.rpc.reply(row.packet.id, { decision })
    this.resolve(id); return true
  }
}
