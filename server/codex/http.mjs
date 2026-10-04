import { controlOptions, modelCatalog } from './controls.mjs'
import http from 'node:http'
import https from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { project } from './mapping.mjs'

const failure = (status, text) => Object.assign(new Error(text), { status })
const hash = value => createHash('sha256').update(value).digest()

async function json(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12 * 1024 * 1024) throw failure(413, 'Message exceeds 12 MiB')
    chunks.push(chunk)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString()) }
  catch { throw failure(400, 'Invalid JSON body') }
}

export function createGateway({ bridge, password, username = 'opencode', directory = homedir(), tls }) {
  if (!password || password.length < 16) throw new Error('Set a gateway password of at least 16 characters')
  const credentials = hash(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
  const streams = new Set()
  const publish = event => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of streams) {
      if (res.writableLength > 1024 * 1024) { res.destroy(); continue }
      res.write(data)
    }
  }
  bridge.on('event', publish)
  bridge.on('disconnect', () => { for (const res of streams) res.end(); streams.clear() })
  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // A browser page must not use ambient Basic credentials to control Codex.
    if (req.headers.origin) throw failure(403, 'Browser origins are not accepted')
    if (!timingSafeEqual(hash(req.headers.authorization || ''), credentials)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Codex gateway"')
      throw failure(401, 'Invalid gateway credentials')
    }
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const method = req.method
    const init = await bridge.rpc.connect()
    const cwd = path.resolve(req.headers['x-opencode-directory'] ? decodeURIComponent(req.headers['x-opencode-directory']) : directory)
    if (method === 'GET' && url.pathname === '/global/event') {
      if (streams.size >= 20) throw failure(503, 'Too many event streams')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
      streams.add(res)
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      for (const state of bridge.threads.values()) bridge.status(state.thread.id, state.thread.status.type)
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000)
      res.on('close', () => { clearInterval(timer); streams.delete(res) })
      return
    }
    const result = await dispatch(method, url, route, req, cwd, init)
    if (res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result ?? null))
  }
  async function dispatch(method, url, route, req, cwd, init) {
    if (method === 'GET') {
      if (url.pathname === '/global/health') return { healthy: true, version: 'codex-gateway/0.2.0', backend: 'codex', codex: init.userAgent }
      if (url.pathname === '/path') return { home: homedir(), state: init.codexHome, config: init.codexHome, worktree: cwd, directory: cwd }
      if (url.pathname === '/project/current') return project(cwd)
      if (url.pathname === '/project') return [...new Set((await bridge.list()).map(t => t.cwd))].map(project)
      if (url.pathname === '/file/roots') return [{ path: homedir(), label: 'Home' }, { path: directory, label: 'Workspace' }]
      if (url.pathname === '/file') {
        const root = path.resolve(cwd, url.searchParams.get('path') || '.')
        return (await readdir(root, { withFileTypes: true })).map(entry => ({ name: entry.name, path: path.relative(cwd, path.join(root, entry.name)), absolute: path.join(root, entry.name), type: entry.isDirectory() ? 'directory' : 'file', ignored: entry.name.startsWith('.') }))
      }
      if (url.pathname === '/session' || url.pathname === '/experimental/session') return (await bridge.list()).map(thread => bridge.describe(thread))
      if (url.pathname === '/permission' || url.pathname === '/question') return [...bridge.pending.values()].filter(row => row.question === (url.pathname === '/question')).map(row => row.value)
      if (url.pathname === '/agent') return [{ name: 'codex', description: 'Codex on your server', mode: 'primary', native: true, options: {} }]
      if (url.pathname === '/codex/options') return controlOptions(bridge.rpc, cwd)
      if (url.pathname === '/codex/limits') {
        const result = await bridge.rpc.call('account/rateLimits/read', {})
        return { rateLimits: result.rateLimits, rateLimitsByLimitId: result.rateLimitsByLimitId, ordinaryUsageAllowed: result.ordinaryUsageAllowed }
      }
      if (url.pathname === '/command') return []
      if (url.pathname === '/config') return {}
      if (url.pathname === '/provider') {
        const rows = await modelCatalog(bridge.rpc)
        const models = Object.fromEntries(rows.filter(m => !m.hidden).map(m => [m.model, { id: m.model, name: m.displayName, attachment: m.inputModalities?.includes('image') || false, reasoning: m.supportedReasoningEfforts?.length > 0, tool_call: true, limit: { context: 0, output: 0 }, variants: Object.fromEntries((m.supportedReasoningEfforts || []).map(v => [v.reasoningEffort, { reasoningEffort: v.reasoningEffort, description: v.description }])) }]))
        return { all: [{ id: 'codex', name: 'Codex', models }], default: {}, connected: ['codex'] }
      }
      if (route[0] === 'session' && route.length >= 2) {
        const state = await bridge.attach(route[1])
        if (route.length === 2) return bridge.describe(state.thread)
        if (route[2] === 'message') return bridge.history(route[1], url.searchParams.has('limit') ? Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 50)) : undefined)
        if (route[2] === 'codex' && route[3] === 'diff') return { diff: await bridge.diff(route[1]) }
        if (route[2] === 'diff') throw failure(501, 'Structured file diffs are not available for Codex; view the file-change tool output')
      }
    }
    if (method === 'POST' && url.pathname === '/session') {
      if (!(await stat(cwd)).isDirectory()) throw failure(400, 'Working directory must exist')
      const body = await json(req)
      return bridge.create(cwd, body.title)
    }
    if (route[0] === 'session' && route.length >= 2) {
      const id = route[1]
      if (method === 'PATCH' && route[2] === 'codex') return bridge.updateSettings(id, await json(req))
      if (method === 'POST' && route[2] === 'compact') return bridge.compact(id)
      if (method === 'PATCH' && route.length === 2) {
        const body = await json(req)
        if (body.time?.archived) throw failure(501, 'Archiving through this client is not supported yet')
        if (typeof body.title !== 'string' || !body.title.trim()) throw failure(400, 'A title is required')
        await bridge.rpc.call('thread/name/set', { threadId: id, name: body.title })
        const state = await bridge.attach(id); state.thread.name = body.title
        bridge.event('session.updated', { info: bridge.describe(state.thread) })
        return bridge.describe(state.thread)
      }
      if (method === 'POST' && route[2] === 'prompt_async') { await bridge.prompt(id, await json(req)); return {} }
      if (method === 'POST' && route[2] === 'abort') return bridge.abort(id)
      throw failure(501, 'This action is not supported for Codex sessions')
    }
    if (method === 'POST' && ['permission', 'question'].includes(route[0]) && route.length === 3 && ['reply', 'reject'].includes(route[2])) return bridge.reply(route[1], await json(req), route[0] === 'question', route[2] === 'reject')
    throw failure(404, 'Unknown endpoint')
  }
  const listener = (req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(error.status || 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    })
  }
  const server = tls ? https.createServer({ ...tls, minVersion: 'TLSv1.2' }, listener) : http.createServer(listener)
  server.requestTimeout = 30000
  server.headersTimeout = 15000
  server.on('close', () => bridge.off('event', publish))
  return server
}
