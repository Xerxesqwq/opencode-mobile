export interface PatchLine {
  index: number
  kind: "add" | "remove" | "context" | "meta"
  text: string
  oldLine: number | null
  newLine: number | null
}

export function parsePatch(patch: string): PatchLine[] {
  let oldLine: number | null = null, newLine: number | null = null
  return patch.replace(/\r\n/g, "\n").split("\n").filter((text, i, rows) => text || i < rows.length - 1).map((text, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { index, kind: "meta", text, oldLine: null, newLine: null } }
    if (/^(diff |index |--- |\+\+\+ |\*\*\* |\\ No newline|Binary files|new file mode|deleted file mode|rename )/.test(text)) return { index, kind: "meta", text, oldLine: null, newLine: null }
    if (text.startsWith("+")) return { index, kind: "add", text: text.slice(1), oldLine: null, newLine: newLine === null ? null : newLine++ }
    if (text.startsWith("-")) return { index, kind: "remove", text: text.slice(1), oldLine: oldLine === null ? null : oldLine++, newLine: null }
    if (text.startsWith(" ")) return { index, kind: "context", text: text.slice(1), oldLine: oldLine === null ? null : oldLine++, newLine: newLine === null ? null : newLine++ }
    return { index, kind: "meta", text, oldLine: null, newLine: null }
  })
}

export type FoldedLine = PatchLine | { kind: "fold"; index: number; count: number }
export function foldPatch(lines: PatchLine[], expanded: ReadonlySet<number> = new Set()): FoldedLine[] {
  const output: FoldedLine[] = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== "context") { output.push(lines[i++]); continue }
    let end = i
    while (end < lines.length && lines[end].kind === "context") end++
    const run = lines.slice(i, end)
    if (run.length <= 8 || expanded.has(run[0].index)) output.push(...run)
    else output.push(...run.slice(0, 3), { kind: "fold", index: run[0].index, count: run.length - 6 }, ...run.slice(-3))
    i = end
  }
  return output
}

export function codeTokens(text: string, path: string): Array<{ text: string; color?: string }> {
  // Bounded, line-level highlighting for common code and configuration files.
  if (text.length > 4000) return [{ text }]
  const hashComments = /\.(py|sh|bash|ya?ml|toml|rb|r)$/i.test(path)
  const expression = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#.*$|\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|def|try|catch|except|throw|new|true|false|null|None|True|False|public|private|interface|type|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b)/g
  const tokens: Array<{ text: string; color?: string }> = []
  let position = 0
  for (const match of text.matchAll(expression)) {
    const index = match.index!, value = match[0]
    if (index > position) tokens.push({ text: text.slice(position, index) })
    const comment = value.startsWith('//') || (hashComments && value.startsWith('#'))
    tokens.push({ text: value, color: comment ? '#768390' : /^["'`]/.test(value) ? '#198754' : /^\d/.test(value) ? '#c77700' : value.startsWith('#') ? undefined : '#8b5cf6' })
    position = index + value.length
  }
  if (position < text.length) tokens.push({ text: text.slice(position) })
  return tokens
}
