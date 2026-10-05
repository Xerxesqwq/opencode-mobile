// Local, deterministic transport for Android navigation regressions. No inference.
// Bind only to loopback; use adb reverse for the emulator.
import http from 'node:http'

const port = Number(process.env.NAVIGATION_PORT || 14101)
const ids = ['navigation-a', 'navigation-b']
const sessions = ids.map((id, index) => ({
  id, title: index ? 'Navigation B fixture' : 'Navigation A Chiikawa fixture',
  directory: '/navigation/' + (index ? 'B' : 'A'), projectID: 'navigation', slug: id,
  version: 'fixture', time: { created: 1, updated: 10 - index },
  codex: { model: 'gpt-6-luna', effort: 'low', mode: 'default', runtimeStatus: 'idle', canAcceptDirectInput: true, compacting: false, instructionSources: [], tokenUsage: null, plan: null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly' }, permissionProfile: null, serviceTier: 'default' },
}))
const messages = new Map(ids.map((id, index) => [id, [{
  info: { id: 'message-' + id, sessionID: id, role: 'assistant', time: { created: 1 }, modelID: 'gpt-6-luna' },
  parts: [{ id: 'part-' + id, sessionID: id, messageID: 'message-' + id, type: 'text', text: index ? 'NAV_B_ONLY' : 'NAV_A_ONLY' }],
}]]))
const held = new Set(), pending = new Map(), streams = new Set(), requests = [], writes = []
let createFailure = false, createDelay = 0, creations = 0
const json = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) } }
const event = (type, properties) => {
  const frame = 'data: ' + JSON.stringify({ directory: '/navigation', payload: { type, properties } }) + '\n\n'
  for (const res of streams) res.write(frame)
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), route = url.pathname
  const segments = route.split('/').filter(Boolean), id = segments[1]
  let body = {}
  if (req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return json(res, 400, {}) }
  }
  if (route.startsWith('/__control')) {
    if (route === '/__control/create') { createFailure = !!body.fail; createDelay = body.delay || 0 }
    if (route === '/__control/long') messages.set(body.id, Array.from({ length: 60 }, (_, index) => {
      const messageID = 'long-' + index
      return { info: { id: messageID, sessionID: body.id, role: 'assistant', time: { created: index }, modelID: 'gpt-6-luna' }, parts: [{ id: messageID + '-text', messageID, sessionID: body.id, type: 'text', text: '## Reply ' + index + '\n\n' + 'A long conversation for Android view recycling.\n\n'.repeat(8) }] }
    }))
    if (route === '/__control/hold') held.add(body.id)
    if (route === '/__control/release') {
      held.delete(body.id)
      for (const response of pending.get(body.id) || []) json(response, body.status || 200, body.status ? { error: 'Simulated loading failure' } : messages.get(body.id))
      pending.delete(body.id)
    }
    if (route === '/__control/event') {
      event(body.type, body.properties)
      if (body.close) for (const stream of streams) stream.end()
    }
    return json(res, 200, { held: [...held], pending: Object.fromEntries([...pending].map(([id, values]) => [id, values.length])), requests, writes, creations })
  }
  requests.push({ method: req.method, route, directory: req.headers['x-opencode-directory'] || null })
  if (route === '/global/health') return json(res, 200, { healthy: true, backend: 'codex', version: 'navigation-fixture' })
  if (route === '/global/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n'); streams.add(res)
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000)
    req.on('close', () => { streams.delete(res); clearInterval(timer) })
    return
  }
  if (route === '/project/current') return json(res, 200, { id: 'navigation', worktree: '/navigation', time: { created: 1 } })
  if (route === '/path') return json(res, 200, { home: '/navigation', worktree: '/navigation', directory: '/navigation' })
  if (route === '/codex/options') return json(res, 200, { models: [{ id: 'gpt-6-luna', name: 'Luna', efforts: [{ reasoningEffort: 'low', description: 'Low' }], defaultEffort: 'low', serviceTiers: [] }], permissionProfiles: [], approvalPolicies: ['on-request'], modes: ['default'] })
  if (route === '/codex/limits') return json(res, 200, { rateLimits: {} })
  if (route === '/provider') return json(res, 200, { all: [], default: {}, connected: [] })
  if (['/agent', '/command', '/permission', '/question', '/project'].includes(route)) return json(res, 200, [])
  if (route === '/session' && req.method === 'POST') {
    await new Promise(resolve => setTimeout(resolve, createDelay))
    if (createFailure) return json(res, 503, { error: 'Simulated creation failure' })
    const id = 'navigation-new-' + ++creations
    const created = { ...sessions[0], id, title: 'New session ' + creations, directory: req.headers['x-opencode-directory'] || '/navigation', time: { created: Date.now(), updated: Date.now() } }
    ids.push(id); sessions.push(created); messages.set(id, [])
    event('session.created', { info: created })
    return json(res, 200, created)
  }
  if (['/session', '/experimental/session', '/codex/library'].includes(route)) return json(res, 200, sessions)
  if (['/session/status', '/config', '/config/providers'].includes(route)) return json(res, 200, {})
  if (segments[0] === 'session' && ids.includes(id)) {
    const session = sessions.find(value => value.id === id)
    if (req.headers['x-opencode-directory'] !== session.directory) return json(res, 404, { error: 'Wrong directory' })
    if (segments.length === 2) return json(res, 200, session)
    if (segments[2] === 'message') {
      if (!held.has(id)) return json(res, 200, messages.get(id))
      const queue = pending.get(id) || []; queue.push(res); pending.set(id, queue)
      return
    }
    // The fork UI pushes the seeded B route so back-stack ownership can be checked.
    if (segments[2] === 'codex' && segments[3] === 'fork') return json(res, 200, { session: sessions[1], sourceID: id, draft: null })
    if (segments[2] === 'prompt_async') {
      writes.push({ id, body })
      const messageID = 'sent-' + writes.length
      messages.get(id).push({ info: { id: messageID, sessionID: id, role: 'user', time: { created: Date.now() } }, parts: body.parts.map((part, index) => ({ ...part, id: messageID + '-' + index, messageID, sessionID: id })) })
      event('session.status', { sessionID: id, status: { type: 'idle' } })
      return json(res, 200, {})
    }
  }
  return json(res, 404, { error: 'Unsupported fixture operation' })
})
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, sessions })))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const res of streams) res.end()
  for (const queue of pending.values()) for (const res of queue) res.destroy()
  server.close(() => process.exit(0))
})
