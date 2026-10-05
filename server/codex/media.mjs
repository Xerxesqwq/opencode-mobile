import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (status, message) => Object.assign(new Error(message), { status })
const MAX_BYTES = 24 * 1024 * 1024

// Markdown destinations with spaces use angle brackets. Keep inline titles and
// common balanced parentheses intact when rewriting only the destination.
const markdownPattern = /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\s]|\([^()\n]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/g
export function markdownImages(text) {
  return [...String(text || '').matchAll(markdownPattern)].map(match => ({
    source: match[1] || match[2], start: match.index, text: match[0],
  }))
}

function image(value, cwd, label) {
  if (typeof value !== 'string' || !value) return null
  if (/^data:image\//i.test(value)) return { kind: 'data', value, label }
  if (/^https?:\/\//i.test(value)) return { kind: 'remote', value, label }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('file://')) return null
  try {
    const filename = value.startsWith('file://') ? fileURLToPath(value) : decodeURIComponent(value.replace(/\\([() ])/g, '$1'))
    return { kind: 'file', path: path.resolve(cwd, filename), label: label || path.basename(filename) }
  } catch { return null }
}

export function itemImages(item, cwd) {
  if (item.type === 'imageView') return [image(item.path, cwd)].filter(Boolean)
  if (item.type === 'imageGeneration') {
    if (!item.result && !item.savedPath) return []
    const data = item.result ? (/^(data:|https?:)/.test(item.result) ? item.result : `data:image/png;base64,${item.result}`) : null
    const result = image(item.savedPath || data, cwd, 'Generated image')
    if (result?.kind === 'file' && data) result.fallback = data
    return result ? [result] : []
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return markdownImages(item.text).map(row => image(row.source, cwd)).filter(Boolean)
  }
  const content = item.type === 'userMessage' ? item.content
    : item.type === 'mcpToolCall' ? item.result?.content
    : item.type === 'dynamicToolCall' ? item.contentItems
    : item.type === 'functionCallOutput' ? item.output : null
  if (!Array.isArray(content)) return []
  return content.flatMap(part => {
    const value = part.type === 'localImage' ? part.path
      : part.type === 'inputImage' ? part.imageUrl
      : part.type === 'input_image' ? part.image_url
      : part.type === 'image' ? part.url || (part.data ? `data:${part.mimeType || 'image/png'};base64,${part.data}` : null) : null
    const result = image(value, cwd)
    return result ? [result] : []
  })
}

export const mediaUrl = (thread, item, index) => `/session/${encodeURIComponent(thread.id)}/codex/media/${encodeURIComponent(item.id)}/${index}`

export function imageParts(thread, item, base) {
  return itemImages(item, thread.cwd).map((source, index) => ({
    ...base, id: `${base.messageID}:image:${index}`, type: 'file', mime: 'image/*',
    url: source.kind === 'remote' ? source.value : mediaUrl(thread, item, index),
    filename: source.label || (source.kind === 'file' ? path.basename(source.path) : undefined),
  }))
}

export function imageMarkdown(thread, item) {
  let index = 0
  return String(item.text || '').replace(markdownPattern, (match, bracketed, plain) => {
    const source = image(bracketed || plain, thread.cwd)
    if (!source) return match
    const url = source.kind === 'remote' ? source.value : mediaUrl(thread, item, index)
    index++
    return match.replace(bracketed || plain, url)
  })
}

// Images travel through the binary endpoint, never as megabytes of tool JSON/SSE.
export function withoutImageData(value) {
  if (typeof value === 'string') return value.replace(/data:image\/[^;\s]+;base64,[A-Za-z\d+/=\r\n]+/g, '[Image preview]')
  if (Array.isArray(value)) return value.map(withoutImageData)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, part]) => [key,
    value.type === 'image' && key === 'data' ? '[Image preview]' : withoutImageData(part),
  ]))
}

function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'image/avif'
  throw fail(415, 'This attachment is not a supported raster image')
}

async function bytesFor(source) {
  if (source.kind === 'data') {
    if (source.value.length > MAX_BYTES * 1.4) throw fail(413, 'Image exceeds 24 MiB')
    const match = /^data:image\/[^;,]+;base64,([A-Za-z\d+/=\r\n]+)$/i.exec(source.value)
    if (!match) throw fail(415, 'Invalid image data')
    const bytes = Buffer.from(match[1], 'base64')
    if (bytes.length > MAX_BYTES) throw fail(413, 'Image exceeds 24 MiB')
    return bytes
  }
  if (source.kind !== 'file') throw fail(400, 'Remote images load from their original URL')
  let file
  try {
    file = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile()) throw fail(415, 'Image source is not a regular file')
    if (stat.size > MAX_BYTES) throw fail(413, 'Image exceeds 24 MiB')
    // Bound reads even if the file grows after stat().
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > stat.size) throw fail(409, 'Image changed while loading; retry')
    return bytes.subarray(0, length)
  } catch (error) {
    if (source.fallback && ['ENOENT', 'EACCES'].includes(error.code)) return bytesFor({ kind: 'data', value: source.fallback })
    if (error.code === 'ENOENT') throw fail(404, 'Image file is no longer available')
    if (error.code === 'EACCES') throw fail(403, 'Image file is not readable')
    throw error
  } finally { await file?.close() }
}

export async function readMedia(bridge, threadId, itemId, index) {
  if (!/^\d+$/.test(index) || Number(index) > 1000) throw fail(400, 'Invalid image index')
  let thread = bridge.threads.get(threadId)?.thread
  let item = [...(bridge.threads.get(threadId)?.turns.values() || [])].flatMap(turn => turn.items).find(row => row.id === itemId)
  if (!item) {
    thread = (await bridge.rpc.call('thread/read', { threadId, includeTurns: false })).thread
    const seen = new Set()
    for (let cursor; ;) {
      const page = await bridge.rpc.call('thread/items/list', { threadId, cursor, limit: 8, sortDirection: 'desc' })
      item = page.data.find(row => row.item.id === itemId)?.item
      if (item || !page.nextCursor || seen.has(page.nextCursor)) break
      seen.add(page.nextCursor); cursor = page.nextCursor
    }
  }
  if (!item) throw fail(404, 'Image item is not in this session')
  const source = itemImages(item, thread.cwd)[Number(index)]
  if (!source) throw fail(404, 'Image is not in this message')
  const bytes = await bytesFor(source)
  return { bytes, mime: mime(bytes) }
}
