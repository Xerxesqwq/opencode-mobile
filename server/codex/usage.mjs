import { open, realpath } from 'node:fs/promises'
import path from 'node:path'

const counts = value => ({
  totalTokens: value.total_tokens ?? 0, inputTokens: value.input_tokens ?? 0,
  cachedInputTokens: value.cached_input_tokens ?? 0, cacheWriteInputTokens: value.cache_write_input_tokens ?? 0,
  outputTokens: value.output_tokens ?? 0, reasoningOutputTokens: value.reasoning_output_tokens ?? 0,
})

// Metadata-only resume in Codex 0.160 does not replay usage for a loaded thread.
// Read only the tail of the daemon-provided rollout, within its own state directory.
// Live notifications remain authoritative. Never return rollout message contents.
export async function restoredUsage(rolloutPath, codexHome) {
  if (!rolloutPath || !codexHome) return null
  let file
  try {
    const [root, target] = await Promise.all([realpath(codexHome), realpath(rolloutPath)])
    if (!target.startsWith(root + path.sep) || !target.endsWith('.jsonl')) return null
    file = await open(target, 'r')
    const { size } = await file.stat()
    const start = Math.max(0, size - 8 * 1024 * 1024)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start) lines.shift()
    for (let index = lines.length - 1; index >= 0; index--) {
      let record
      try { record = JSON.parse(lines[index]) } catch { continue }
      if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue
      const info = record.payload.info
      if (!info?.last_token_usage || !info?.total_token_usage) continue
      return { last: counts(info.last_token_usage), total: counts(info.total_token_usage), modelContextWindow: info.model_context_window ?? null }
    }
  } catch { return null }
  finally { await file?.close() }
  return null
}
