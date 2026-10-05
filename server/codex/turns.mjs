// Image results can be several MiB each. Fetch turn metadata separately so a
// long turn does not put every base64 image into one WebSocket message.
export async function turnPage(rpc, params) {
  let page
  try { page = await rpc.call('thread/turns/list', { ...params, itemsView: 'notLoaded' }) }
  catch (error) {
    // A loaded thread has no persisted history until its first user message.
    if (error.code === -32600 && /is not materialized yet; thread\/turns\/list is unavailable before first user message/.test(error.message)) {
      return { data: [], nextCursor: null, unmaterialized: true }
    }
    throw error
  }
  for (const turn of page.data) {
    if (turn.itemsView !== 'notLoaded') continue
    const items = [], seen = new Set()
    for (let cursor; ;) {
      const result = await rpc.call('thread/items/list', { threadId: params.threadId, turnId: turn.id, cursor, limit: 8, sortDirection: 'asc' })
      items.push(...result.data.map(row => row.item))
      if (!result.nextCursor || seen.has(result.nextCursor)) break
      seen.add(result.nextCursor); cursor = result.nextCursor
    }
    turn.items = items; turn.itemsView = 'full'
  }
  return page
}
