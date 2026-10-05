import type { CodexDraft } from "./codex"

// Drafts cross a single navigation to a newly created fork; image data stays out of URLs.
const pending = new Map<string, CodexDraft>()
export function queueCodexDraft(id: string, draft: CodexDraft) {
  if (pending.size >= 10) pending.delete(pending.keys().next().value!)
  pending.set(id, draft)
}
export function takeCodexDraft(id: string) {
  const draft = pending.get(id)
  pending.delete(id)
  return draft
}
