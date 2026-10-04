import { createHash } from 'node:crypto'

export const projectId = cwd => createHash('sha256').update(cwd).digest('hex').slice(0, 20)
export const project = cwd => ({ id: projectId(cwd), name: cwd.split('/').filter(Boolean).at(-1) || '/', path: { cwd, root: cwd, absolute: cwd } })
export const session = thread => ({
  id: thread.id, slug: thread.id, projectID: projectId(thread.cwd), directory: thread.cwd,
  parentID: thread.parentThreadId || undefined, title: thread.name || thread.preview || 'New Codex session',
  version: thread.cliVersion || 'codex', time: { created: thread.createdAt * 1000, updated: thread.updatedAt * 1000 },
})

export function messages(thread, turns) {
  return turns.flatMap(turn => turn.items.map((item, index) => message(thread, turn, item, index)))
}

export function message(thread, turn, item, index = 0) {
  const user = item.type === 'userMessage'
  const created = (turn.startedAt ?? thread.createdAt) * 1000 + index
  const completed = turn.status === 'inProgress' ? undefined : (turn.completedAt ?? thread.updatedAt) * 1000
  const id = user ? item.clientId || item.id : item.id
  const info = { id, sessionID: thread.id, role: user ? 'user' : 'assistant',
    time: { created, ...(user ? {} : { completed }) }, providerID: 'codex', modelID: thread.model || undefined,
    ...(turn.error && !user ? { error: { message: turn.error.message } } : {}),
    ...(!user && completed ? { finish: turn.status === 'interrupted' ? 'stop' : 'end_turn' } : {}),
  }
  const base = { id: `${id}:0`, sessionID: thread.id, messageID: id }
  if (user) return { info, parts: item.content.map((part, n) => ({ ...base, id: `${id}:${n}`,
    ...(part.type === 'text' ? { type: 'text', text: part.text } : part.type === 'image' ? { type: 'file', mime: 'image/*', url: part.url } : { type: 'text', text: `[${part.type}] ${part.path || part.name || ''}` }),
  })) }
  if (item.type === 'agentMessage' || item.type === 'plan') return { info, parts: [{ ...base, type: 'text', text: [item.text || '', ...(item.questions || []).map(q => [q.title, ...(q.options || []).map(option => `• ${option}`)].join('\n'))].filter(Boolean).join('\n\n') }] }
  if (item.type === 'contextCompaction') return { info, parts: [{ ...base, type: 'text', text: item.status === 'inProgress' ? 'Compacting context…' : 'Context compacted.' }] }
  if (item.type === 'reasoning') return { info, parts: [{ ...base, type: 'reasoning', text: (item.summary?.length ? item.summary : item.content || []).join('\n') }] }
  const failed = item.status === 'failed' || item.status === 'declined' || item.success === false
  const output = item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.changes ?? item.output ?? item.text ?? item
  return { info, parts: [{ ...base, type: 'tool', callID: item.id, tool: item.type === 'commandExecution' ? 'bash' : item.type === 'fileChange' ? 'apply_patch' : item.tool || item.type,
    state: { status: failed ? 'error' : item.status === 'inProgress' ? 'running' : 'completed',
      title: item.command || item.tool || item.type, input: item.arguments ?? (item.command ? { command: item.command, cwd: item.cwd } : item),
      output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
      ...(failed ? { error: { message: item.error?.message || `Codex ${item.status || 'tool failed'}` } } : {}),
    },
  }] }
}

export function input(parts) {
  if (!Array.isArray(parts) || !parts.length) throw Object.assign(new Error('A message is required'), { status: 400 })
  return parts.map(part => {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text, text_elements: [] }
    if (part.type === 'file' && /^image\//.test(part.mime) && typeof part.url === 'string' && /^data:image\//.test(part.url)) return { type: 'image', url: part.url }
    throw Object.assign(new Error('Codex supports text and embedded image attachments'), { status: 400 })
  })
}
