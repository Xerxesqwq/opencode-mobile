import { message, session } from './mapping.mjs'

const fail = (status, text) => Object.assign(new Error(text), { status })

export async function allTurns(rpc, id, itemsView = 'full') {
  const rows = [], seen = new Set()
  for (let cursor; ;) {
    const page = await rpc.call('thread/turns/list', { threadId: id, cursor, limit: 20, sortDirection: 'desc', itemsView })
    rows.push(...page.data)
    if (!page.nextCursor || seen.has(page.nextCursor)) return rows
    seen.add(page.nextCursor); cursor = page.nextCursor
  }
}

export async function searchHistory(bridge, id, query, kind = 'all', offset = 0) {
  const text = query.trim()
  if (!text || text.length > 200 || !['all', 'user', 'assistant', 'tool'].includes(kind)) throw fail(400, 'Enter a search of 1–200 characters and a valid message type')
  const { thread } = await bridge.rpc.call('thread/read', { threadId: id, includeTurns: false })
  const turns = await allTurns(bridge.rpc, id)
  const matches = [], needle = text.toLocaleLowerCase()
  for (const turn of turns) for (const [index, item] of turn.items.entries()) {
    const row = message(thread, turn, item, index)
    for (const part of row.parts) {
      const type = part.type === 'tool' ? 'tool' : row.info.role
      if (kind !== 'all' && kind !== type) continue
      const content = part.type === 'text' ? part.text : part.type === 'tool'
        ? [part.state.title, JSON.stringify(part.state.input), typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output)].filter(Boolean).join('\n') : ''
      const at = content?.toLocaleLowerCase().indexOf(needle) ?? -1
      if (at < 0) continue
      matches.push({ messageId: row.info.id, turnId: turn.id, kind: type,
        snippet: `${at > 60 ? '…' : ''}${content.slice(Math.max(0, at - 60), at + text.length + 140)}${at + text.length + 140 < content.length ? '…' : ''}` })
      break
    }
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  return { results: matches.slice(start, start + 50), total: matches.length, nextOffset: start + 50 < matches.length ? start + 50 : null }
}

// Native add/delete records contain file contents; updates contain unified patches.
function recordedPatch(change) {
  const kind = change.kind?.type || change.kind
  const diff = change.diff || ''
  if (!['add', 'delete'].includes(kind)) return diff
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const added = kind === 'add', count = lines.length
  return [`--- ${added ? '/dev/null' : change.path}`, `+++ ${added ? change.path : '/dev/null'}`,
    `@@ -${added ? '0,0' : `1,${count}`} +${added ? `1,${count}` : '0,0'} @@`,
    ...lines.map(line => `${added ? '+' : '-'}${line}`)].join('\n') + '\n'
}

export async function fileChanges(bridge, id, selectedTurn) {
  const turns = await allTurns(bridge.rpc, id)
  const choices = turns.filter(turn => turn.items.some(item => item.type === 'fileChange')).map(turn => ({ id: turn.id, startedAt: turn.startedAt, status: turn.status }))
  const turn = selectedTurn ? turns.find(turn => turn.id === selectedTurn) : turns.find(turn => turn.items.some(item => item.type === 'fileChange'))
  if (selectedTurn && !turn) throw fail(404, 'This turn is no longer in the conversation')
  const files = new Map()
  for (const item of turn?.items || []) if (item.type === 'fileChange') for (const change of item.changes || []) {
    const key = change.path
    const entry = files.get(key) || { path: key, kind: change.kind?.type || change.kind || 'update', diffs: [], status: item.status }
    entry.status = item.status
    entry.diffs.push(recordedPatch(change))
    files.set(key, entry)
  }
  return { turnId: turn?.id ?? null, turns: choices, files: [...files.values()].map(file => ({ ...file, diff: file.diffs.join('\n'), diffs: undefined })) }
}

async function idleThread(bridge, id) {
  const { thread } = await bridge.rpc.call('thread/read', { threadId: id, includeTurns: false })
  if (thread.status.type === 'active' || bridge.threads.get(id)?.compacting) throw fail(409, 'Stop or finish the current task first')
  return thread
}

export async function mutateThread(bridge, id, operation) {
  if (bridge.mutations.has(id)) throw fail(409, 'A session change is already in progress')
  bridge.mutations.add(id)
  try { return await operation() } finally { bridge.mutations.delete(id) }
}

function promptDraft(user) {
  return { text: user.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    images: user.content.filter(part => part.type === 'image' && /^data:image\//.test(part.url || '')).map(part => part.url),
    omittedAttachments: user.content.filter(part => part.type !== 'text' && !(part.type === 'image' && /^data:image\//.test(part.url || ''))).length }
}

export async function forkHistory(bridge, id, beforeTurnId) {
  if (beforeTurnId !== undefined && (typeof beforeTurnId !== 'string' || !beforeTurnId)) throw fail(400, 'Choose a valid turn to fork before')
  return mutateThread(bridge, id, async () => {
    const thread = await idleThread(bridge, id)
    if (thread.canAcceptDirectInput === false) throw fail(409, 'This thread is managed by its parent')
    const source = (await bridge.attach(id)).settings
    let user
    if (beforeTurnId) {
      const turn = (await allTurns(bridge.rpc, id)).find(turn => turn.id === beforeTurnId)
      user = turn?.items.find(item => item.type === 'userMessage')
      if (!user) throw fail(400, 'Choose a user turn that is still in the conversation')
    }
    const result = await bridge.rpc.call('thread/fork', { threadId: id, model: source.model ?? undefined, modelProvider: thread.modelProvider, cwd: thread.cwd, ...(beforeTurnId ? { beforeTurnId } : {}), excludeTurns: true, deferGoalContinuation: true })
    const branch = result.thread.id
    try {
      await bridge.rpc.call('thread/name/set', { threadId: branch, name: `Fork · ${thread.name || thread.preview || 'Codex'} · ${new Date().toISOString()}` })
      const params = { threadId: branch, cwd: thread.cwd, serviceTier: source.serviceTier }
      for (const key of ['model', 'effort', 'approvalPolicy', 'approvalsReviewer']) if (source[key] != null) params[key] = source[key]
      if (source.activePermissionProfile?.id) params.permissions = source.activePermissionProfile.id
      else if (source.sandboxPolicy) params.sandboxPolicy = source.sandboxPolicy
      if (source.collaborationMode) params.collaborationMode = { ...source.collaborationMode,
        settings: { ...source.collaborationMode.settings, model: source.model, reasoning_effort: source.effort } }
      // Native fork can restore configuration defaults. Confirm the source's
      // current effective settings on the new branch before returning it.
      const session = await bridge.applySettings(branch, params)
      bridge.event('codex.library.changed', { sessionID: branch })
      return { session, sourceID: id, draft: user ? promptDraft(user) : null }
    } catch (error) { throw fail(error.status || 502, `${error.message}. Created branch: ${branch}`) }
  })
}

export async function revertHistory(bridge, id, beforeTurnId) {
  if (typeof beforeTurnId !== 'string' || !beforeTurnId) throw fail(400, 'Choose a turn to retry')
  return mutateThread(bridge, id, async () => {
    const thread = await idleThread(bridge, id)
    if (thread.canAcceptDirectInput === false) throw fail(409, 'This thread is managed by its parent')
    const turns = await allTurns(bridge.rpc, id)
    const turn = turns.find(turn => turn.id === beforeTurnId)
    const user = turn?.items.find(item => item.type === 'userMessage')
    if (!turn || !user) throw fail(400, 'Choose a user turn that is still in the conversation')
    // Keep the complete conversation recoverable before changing its history.
    // The fork is inert until a user explicitly starts a turn in it.
    const backup = await bridge.rpc.call('thread/fork', { threadId: id, excludeTurns: true, deferGoalContinuation: true })
    const title = `Backup · ${thread.name || thread.preview || 'Codex'} · ${new Date().toISOString()}`
    await bridge.rpc.call('thread/name/set', { threadId: backup.thread.id, name: title })
    backup.thread.name = title
    await idleThread(bridge, id)
    try { await bridge.rpc.call('thread/revert', { threadId: id, beforeTurnId }) }
    catch (error) { throw fail(error.status || 502, `${error.message}. Full conversation backup: ${backup.thread.id}`) }
    bridge.threads.delete(id); bridge.observed.delete(id)
    const state = await bridge.attach(id)
    bridge.event('codex.history.changed', { sessionID: id })
    return { session: bridge.describe(state.thread), backup: session(backup.thread),
      draft: promptDraft(user) }
  })
}

export async function archiveSessions(bridge, ids, archived) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id) || typeof archived !== 'boolean') throw fail(400, 'Select between 1 and 100 sessions')
  const results = []
  for (const id of new Set(ids)) {
    try {
      await mutateThread(bridge, id, async () => {
        if (archived) await idleThread(bridge, id)
        await bridge.rpc.call(archived ? 'thread/archive' : 'thread/unarchive', { threadId: id })
        bridge.threads.delete(id); bridge.observed.delete(id)
      })
      results.push({ id, ok: true })
    } catch (error) { results.push({ id, ok: false, error: error.message }) }
  }
  if (results.some(result => result.ok)) bridge.event('codex.library.changed', { archived })
  return { results }
}

export function taskStatus(thread, turn, pending) {
  const flags = thread.status.activeFlags || []
  if (pending?.question || flags.includes('waitingOnUserInput')) return 'input'
  if (pending || flags.includes('waitingOnApproval')) return 'approval'
  if (thread.status.type === 'active') return 'running'
  if (thread.status.type === 'systemError' || turn?.status === 'failed') return 'failed'
  if (turn?.status === 'interrupted') return 'interrupted'
  if (turn?.status === 'completed') return 'completed'
  return 'idle'
}

export async function taskOverview(bridge) {
  const threads = await bridge.list()
  const loaded = new Set(), cursors = new Set()
  for (let cursor; ;) {
    const page = await bridge.rpc.call('thread/loaded/list', { cursor, limit: 100 })
    for (const id of page.data) loaded.add(id)
    if (!page.nextCursor || cursors.has(page.nextCursor)) break
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
  // Read live metadata without resuming or changing a running thread.
  const candidates = threads.filter((thread, index) => index < 100 || loaded.has(thread.id))
  const items = new Array(candidates.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    for (;;) {
      const position = index++
      if (position >= candidates.length) return
      let thread = candidates[position], turn, error
      try {
        if (loaded.has(thread.id)) ({ thread } = await bridge.rpc.call('thread/read', { threadId: thread.id, includeTurns: false }))
        const key = `${thread.id}/${thread.updatedAt}`
        const cached = bridge.taskCache.get(key)
        if (thread.status.type !== 'active') {
          if (cached && Date.now() - cached.time < 5000) turn = cached.turn
          else {
            const page = await bridge.rpc.call('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'summary' })
            turn = page.data[0]
            bridge.taskCache.set(key, { time: Date.now(), turn })
          }
        }
      } catch (e) { error = e.message }
      const pending = [...bridge.pending.values()].find(request => request.value.sessionID === thread.id)
      items[position] = { session: session(thread), state: taskStatus(thread, turn, pending),
        canStop: thread.status.type === 'active' && thread.canAcceptDirectInput !== false,
        error: turn?.error?.message || error || null, statusUnavailable: !!error && thread.status.type !== 'active' }
    }
  }))
  for (const [key, value] of bridge.taskCache) if (Date.now() - value.time > 30000) bridge.taskCache.delete(key)
  const order = { approval: 0, input: 1, running: 2, failed: 3, interrupted: 4, completed: 5, idle: 6 }
  items.sort((a, b) => order[a.state] - order[b.state] || b.session.time.updated - a.session.time.updated)
  return { items, recentLimit: 100, includesAllLoaded: true, totalSessions: threads.length, updatedAt: Date.now() }
}
