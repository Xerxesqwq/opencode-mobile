import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View, ScrollView } from "react-native"
import { useTranslation } from "react-i18next"
import * as Clipboard from "expo-clipboard"
import type { Client } from "../../lib/sdk"
import { codexError, type CodexFileChanges } from "../../lib/codex"
import { parsePatch, foldPatch, codeTokens, type FoldedLine } from "../../lib/codex-diff"
import { CodexWorkbenchModal, w } from "./CodexWorkbenchModal"

type Row = { key: string; type: 'file'; path: string; diff: string; added: number; removed: number; status: string } | { key: string; type: 'line'; path: string; line: FoldedLine }
export function CodexFiles({ visible, client, sessionId, isDark, onClose }: { visible: boolean; client: Client | null; sessionId?: string; isDark: boolean; onClose: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [data, setData] = useState<CodexFileChanges | null>(null), [turn, setTurn] = useState<string>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [gaps, setGaps] = useState<Record<string, Set<number>>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [copied, setCopied] = useState('')
  const color = isDark ? '#eeeeee' : '#171717', card = isDark ? '#252525' : '#f2f3f5'
  useEffect(() => { setTurn(undefined); setData(null) }, [sessionId])
  useEffect(() => {
    if (!visible || !client || !sessionId) return
    let active = true
    setBusy(true); setError(''); setGaps({})
    client.codex.files(sessionId, turn).then(result => {
      if (active) { setData(result); setExpanded(new Set(result.files.slice(0, 1).map(file => file.path))) }
    }).catch(e => { if (active) setError(codexError(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [visible, client, sessionId, turn, refresh])
  const rows = useMemo(() => {
    const rows: Row[] = []
    for (const file of data?.files || []) {
      const lines = parsePatch(file.diff)
      rows.push({ key: file.path, type: 'file', path: file.path, diff: file.diff, status: file.status, added: lines.filter(line => line.kind === 'add').length, removed: lines.filter(line => line.kind === 'remove').length })
      if (expanded.has(file.path)) for (const line of foldPatch(lines, gaps[file.path])) rows.push({ key: `${file.path}/${line.index}/${line.kind}`, type: 'line', path: file.path, line })
    }
    return rows
  }, [data, expanded, gaps])
  return <CodexWorkbenchModal visible={visible} title={zh ? '文件变更' : 'File changes'} isDark={isDark} onClose={onClose}>
    <View style={w.line}><Text style={w.hint}>{zh ? '按轮次审阅 · 历史补丁' : 'Review changes by turn · recorded patches'}</Text><TouchableOpacity testID="codex-files-refresh" onPress={() => setRefresh(value => value + 1)} style={w.button}><Text style={w.accent}>{zh ? '刷新' : 'Refresh'}</Text></TouchableOpacity></View>
    <View><ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>{data?.turns.map((item, index) => <TouchableOpacity testID={`codex-file-turn-${item.id}`} key={item.id} onPress={() => setTurn(item.id)} style={[w.tab, { backgroundColor: item.id === data.turnId ? '#8b5cf6' : card }]}><Text style={{ color: item.id === data.turnId ? '#ffffff' : color }}>{index === 0 ? (zh ? '最近修改' : 'Latest changes') : item.startedAt ? new Date(item.startedAt * 1000).toLocaleString() : `#${data.turns.length - index}`}</Text></TouchableOpacity>)}</ScrollView></View>
    {busy && <ActivityIndicator color="#8b5cf6" />}{!!error && <Text style={w.error}>{error}</Text>}
    <FlatList data={rows} keyExtractor={row => row.key} windowSize={7} initialNumToRender={20}
      ListEmptyComponent={!busy ? <Text style={w.hint}>{zh ? '当前会话没有文件变更记录' : 'No recorded file changes'}</Text> : null}
      renderItem={({ item }) => {
        if (item.type === 'file') return <View style={[w.row, { backgroundColor: card }]}>
          <TouchableOpacity testID={`codex-file-${item.path}`} onPress={() => setExpanded(previous => { const next = new Set(previous); next.has(item.path) ? next.delete(item.path) : next.add(item.path); return next })}>
            <Text style={[w.rowTitle, { color }]}>{expanded.has(item.path) ? '▾' : '▸'} {item.path}</Text>
            <Text style={{ color: '#198754', marginTop: 6 }}>+{item.added} <Text style={{ color: '#db5050' }}>−{item.removed}</Text> <Text style={{ color: '#888888' }}>{item.status}</Text></Text>
          </TouchableOpacity>
          <TouchableOpacity testID="codex-copy-diff" onPress={async () => { try { await Clipboard.setStringAsync(item.diff); setCopied(item.path) } catch (e) { setError(codexError(e)) } }}><Text style={w.accent}>{copied === item.path ? (zh ? '已复制' : 'Copied') : (zh ? '复制补丁' : 'Copy patch')}</Text></TouchableOpacity>
        </View>
        const line = item.line
        if (line.kind === 'fold') return <TouchableOpacity testID="codex-diff-expand-context" style={w.button} onPress={() => setGaps(previous => ({ ...previous, [item.path]: new Set([...(previous[item.path] || []), line.index]) }))}><Text style={w.accent}>⋯ {zh ? `展开 ${line.count} 行上下文` : `Show ${line.count} context lines`}</Text></TouchableOpacity>
        const backgroundColor = line.kind === 'add' ? (isDark ? '#103721' : '#e1f8e8') : line.kind === 'remove' ? (isDark ? '#3c1c22' : '#ffe8eb') : 'transparent'
        return <View style={{ flexDirection: 'row', backgroundColor, paddingHorizontal: 8, paddingVertical: 2 }}>
          <Text testID="codex-diff-line-number" style={{ fontFamily: 'monospace', fontSize: 10, width: 60, color: '#888888' }}>{line.oldLine ?? '·'}  {line.newLine ?? '·'}</Text>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 19, color, flex: 1 }}>
            {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '− ' : ''}
            {line.kind === 'meta' ? <Text style={{ color: '#888888' }}>{line.text}</Text> : codeTokens(line.text, item.path).map((token, index) => <Text key={index} style={token.color ? { color: token.color } : undefined}>{token.text}</Text>)}
          </Text>
        </View>
      }} />
  </CodexWorkbenchModal>
}
