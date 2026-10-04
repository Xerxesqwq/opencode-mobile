export interface CodexTokenCounts {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexSession {
  model: string | null
  effort: string | null
  approvalPolicy: string | Record<string, unknown> | null
  approvalsReviewer: string | null
  sandboxPolicy: { type: string; writableRoots?: string[]; networkAccess?: boolean | string } | null
  permissionProfile: string | null
  mode: string
  serviceTier: string | null
  instructionSources: string[]
  tokenUsage: { total: CodexTokenCounts; last: CodexTokenCounts; modelContextWindow: number | null } | null
  compacting: boolean
  runtimeStatus: string
  plan: { explanation?: string; steps: Array<{ step: string; status: string }> } | null
  canAcceptDirectInput: boolean
}

export interface CodexOptions {
  models: Array<{ id: string; name: string; efforts: Array<{ reasoningEffort: string; description: string }>; defaultEffort: string; serviceTiers?: Array<{ id: string; name: string; description: string }> }>
  permissionProfiles: Array<{ id: string; description: string | null; allowed: boolean }>
  approvalPolicies: string[]
  modes: string[]
}

export interface CodexSettingsPatch {
  model?: string
  effort?: string
  approvalPolicy?: string
  permissions?: string
  mode?: string
  serviceTier?: 'priority' | 'fast' | null
}

export interface CodexRateLimit {
  limitName?: string | null
  planType?: string | null
  primary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null
  secondary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null
}

export interface CodexLimits {
  rateLimits: CodexRateLimit
  rateLimitsByLimitId?: Record<string, CodexRateLimit> | null
  ordinaryUsageAllowed?: boolean | null
}

// Cached input is part of input; reasoning is part of output. Use the server's
// total instead of adding those overlapping breakdowns together.
export function codexContextUsage(usage: CodexSession["tokenUsage"]) {
  if (!usage) return null
  const used = usage.last.totalTokens
  const limit = usage.modelContextWindow
  return { used, limit, percent: limit && limit > 0 ? Math.round(used / limit * 100) : null }
}

export function codexError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const json = text.indexOf("{")
  if (json >= 0) {
    try { const value = JSON.parse(text.slice(json)); if (typeof value.error === "string") return value.error } catch {}
  }
  return text
}

export interface CodexSearchResult {
  messageId: string
  turnId: string
  kind: "user" | "assistant" | "tool"
  snippet: string
}
export interface CodexSearchPage {
  results: CodexSearchResult[]
  total: number
  nextOffset: number | null
}
export interface CodexFileChanges {
  turnId: string | null
  turns: Array<{ id: string; startedAt?: number; status: string }>
  files: Array<{ path: string; kind: string; diff: string; status: string }>
}
export type CodexTaskState = "running" | "approval" | "input" | "failed" | "completed" | "interrupted" | "idle"

export interface CodexDraft { text: string; images: string[]; omittedAttachments: number }
