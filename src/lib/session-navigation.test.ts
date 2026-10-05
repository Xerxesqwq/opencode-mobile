import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Session, MessageWithParts } from './sdk'

// Exercise the real Zustand store. Only native services and transport are stubbed.
const fixtureKey = Symbol.for('opencode.session-navigation-test')
const pending = new Map<string, ReturnType<typeof deferred<MessageWithParts[]>>>()
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function session(id: string): Session {
  return { id, title: 'Conversation ' + id, directory: '/fixture/' + id, slug: id, projectID: 'fixture', version: '1', time: { created: 1, updated: 1 } }
}
function rows(id: string): MessageWithParts[] {
  return [{ info: { id: 'message-' + id, sessionID: id, role: 'assistant', time: { created: 1 } }, parts: [{ id: 'part-' + id, messageID: 'message-' + id, sessionID: id, type: 'text', text: 'Content of ' + id }] }]
}
const client = { session: {
  get: async (id: string) => session(id),
  messages: async (id: string) => pending.get(id)?.promise ?? rows(id),
  list: async () => [session('A'), session('B')],
} }
const connection = { client, activeConnection: { id: 'fixture-connection' }, clientForDirectory: () => client }
Object.defineProperty(globalThis, fixtureKey, { value: connection, configurable: true })
const native = new Map([
  ['/stores/connections', `export const useConnections = {getState: () => globalThis[Symbol.for('opencode.session-navigation-test')]}`],
  ['/stores/settings', 'export const useSettings = {getState: () => ({pageSize: 1})}'],
  ['/lib/sentry', 'export const addBreadcrumb = () => {}'],
  ['/lib/analytics', 'export const track = () => {}; export const AnalyticsEvent = {}'],
  ['/lib/sdk', 'export class ApiError extends Error {}'],
])
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL)
      const stub = [...native].find(([suffix]) => url.pathname.endsWith(suffix))
      if (stub) return { url: 'data:text/javascript,' + encodeURIComponent(stub[1]), shortCircuit: true }
      if (!url.pathname.endsWith('.ts') && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context)
    }
    return next(specifier, context)
  },
})
const { useSessions } = await import('../stores/sessions.ts')
hooks.deregister()
const initial = useSessions.getState()
beforeEach(() => { pending.clear(); connection.client = client; useSessions.setState(initial, true) })

test('switching sessions immediately removes the previous conversation', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  const during = useSessions.getState()
  delayed.resolve(rows('A')); await selecting
  assert.notEqual(during.currentSession?.id, 'B', 'B must disappear when A is selected')
  assert.equal(during.messages.some(message => message.sessionID === 'B'), false)
  assert.equal(useSessions.getState().currentSession?.id, 'A')
})

test('a late background refresh cannot replace the newly selected messages', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('B', delayed)
  const refresh = useSessions.getState().refreshMessages()
  await useSessions.getState().selectSession('A')
  delayed.resolve(rows('B')); await refresh
  assert.equal(useSessions.getState().currentSession?.id, 'A')
  assert.deepEqual(useSessions.getState().messages.map(message => message.sessionID), ['A'])
})

test('a late history page cannot replace the newly selected messages', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('B', delayed)
  const older = useSessions.getState().loadOlderMessages()
  await useSessions.getState().selectSession('A')
  delayed.resolve(rows('B')); await older
  assert.deepEqual(useSessions.getState().messages.map(message => message.sessionID), ['A'])
})

test('failed selection keeps the previous conversation out of the destination', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  delayed.reject(new Error('Simulated network failure')); await selecting
  assert.notEqual(useSessions.getState().currentSession?.id, 'B')
  assert.equal(useSessions.getState().messages.length, 0)
})

test('list refreshes and old SSE events cannot finish a different conversation load', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  await useSessions.getState().loadSessions()
  useSessions.getState().handleEvent({ type: 'session.updated', properties: { info: session('B') } })
  useSessions.getState().handleEvent({ type: 'message.updated', properties: { info: rows('B')[0].info } })
  const during = useSessions.getState()
  delayed.resolve(rows('A')); await selecting
  assert.equal(during.selectedSessionID, 'A')
  assert.equal(during.sessionLoading, true)
  assert.equal(during.messages.length, 0)
})

test('a failed request exposes a retryable error and never restores old messages', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  delayed.reject(new Error('Expected failure')); await selecting
  assert.equal(useSessions.getState().selectedSessionID, 'A')
  assert.equal(useSessions.getState().sessionLoading, false)
  assert.ok(useSessions.getState().sessionError)
  pending.delete('A')
  await useSessions.getState().selectSession('A')
  assert.equal(useSessions.getState().sessionError, null)
  assert.deepEqual(useSessions.getState().messages.map(message => message.sessionID), ['A'])
})

test('out-of-order selections preserve the most recent destination', async () => {
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  await useSessions.getState().selectSession('B')
  delayed.resolve(rows('A')); await selecting
  assert.equal(useSessions.getState().currentSession?.id, 'B')
  assert.deepEqual(useSessions.getState().messages.map(message => message.sessionID), ['B'])
})

test('returning to the same session rejects a refresh from its previous visit', async () => {
  await useSessions.getState().selectSession('A')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const refresh = useSessions.getState().refreshMessages()
  await useSessions.getState().selectSession('B')
  pending.delete('A')
  await useSessions.getState().selectSession('A')
  const stale = rows('A'); stale[0].info.id = 'stale-previous-visit'
  delayed.resolve(stale); await refresh
  assert.equal(useSessions.getState().messages[0].id, 'message-A')
})

test('responses from a previous connection cannot populate the active connection', async () => {
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  connection.client = { session: { ...client.session } }
  delayed.resolve(rows('A')); await selecting
  assert.equal(useSessions.getState().currentSession, null)
  assert.equal(useSessions.getState().messages.length, 0)
})

test('foreign messages returned by the server fail without entering the conversation', async () => {
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  delayed.resolve(rows('B')); await selecting
  assert.equal(useSessions.getState().currentSession, null)
  assert.ok(useSessions.getState().sessionError)
  assert.equal(useSessions.getState().messages.length, 0)
})

test('same-session refresh remains visible while the response is pending', async () => {
  await useSessions.getState().selectSession('A')
  const delayed = deferred<MessageWithParts[]>(); pending.set('A', delayed)
  const selecting = useSessions.getState().selectSession('A')
  const during = useSessions.getState()
  delayed.resolve(rows('A')); await selecting
  assert.equal(during.sessionLoading, false)
  assert.equal(during.currentSession?.id, 'A')
  assert.deepEqual(during.messages.map(message => message.sessionID), ['A'])
})

test('foreign session metadata cannot change the requested destination', async () => {
  const original = client.session.get
  client.session.get = async () => session('B')
  try {
    await useSessions.getState().selectSession('A')
    assert.equal(useSessions.getState().selectedSessionID, 'A')
    assert.equal(useSessions.getState().currentSession, null)
    assert.ok(useSessions.getState().sessionError)
  } finally { client.session.get = original }
})

test('errors from an old refresh cannot overwrite the new session error state', async () => {
  await useSessions.getState().selectSession('B')
  const delayed = deferred<MessageWithParts[]>(); pending.set('B', delayed)
  const refresh = useSessions.getState().refreshMessages()
  await useSessions.getState().selectSession('A')
  delayed.reject(new Error('Old B request failed')); await refresh
  assert.equal(useSessions.getState().error, null)
  assert.equal(useSessions.getState().sessionError, null)
  assert.deepEqual(useSessions.getState().messages.map(message => message.sessionID), ['A'])
})
