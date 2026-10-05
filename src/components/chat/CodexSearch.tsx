import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Keyboard, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useTranslation } from "react-i18next"
import type { Client } from "../../lib/sdk"
import { codexError, type CodexSearchPage, type CodexSearchResult } from "../../lib/codex"
import { CodexWorkbenchModal, w } from "./CodexWorkbenchModal"

export function CodexSearch({ visible, client, sessionId, isDark, onClose, onSelect }: { visible: boolean; client: Client | null; sessionId?: string; isDark: boolean; onClose: () => void; onSelect: (result: CodexSearchResult) => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all')
  const [page, setPage] = useState<CodexSearchPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  const color = isDark ? '#eeeeee' : '#171717', card = isDark ? '#252525' : '#f2f3f5'
  const labels: Record<string, string> = zh ? { all: '全部', user: '提问', assistant: '回复', tool: '工具' } : { all: 'All', user: 'Prompts', assistant: 'Replies', tool: 'Tools' }
  useEffect(() => { setQuery(''); setPage(null) }, [sessionId])
  useEffect(() => {
    generation.current++; setPage(null); setError('')
    if (!visible || !client || !sessionId || !query.trim()) { setBusy(false); return }
    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(() => {
      client.codex.search(sessionId, query, kind, 0, controller.signal).then(result => { if (!controller.signal.aborted) setPage(result) })
        .catch(e => { if (!controller.signal.aborted) setError(codexError(e)) })
        .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [visible, client, sessionId, query, kind])
  const more = async () => {
    if (!client || !sessionId || page?.nextOffset == null || busy) return
    setBusy(true)
    const epoch = generation.current
    try {
      const next = await client.codex.search(sessionId, query, kind, page.nextOffset)
      setPage(previous => previous && epoch === generation.current ? { ...next, results: [...previous.results, ...next.results] } : previous)
    } catch (e) { if (epoch === generation.current) setError(codexError(e)) } finally { if (epoch === generation.current) setBusy(false) }
  }
  return <CodexWorkbenchModal visible={visible} title={zh ? '搜索会话' : 'Search conversation'} isDark={isDark} onClose={onClose}>
    <TextInput testID="codex-search-input" value={query} onChangeText={setQuery} maxLength={200} autoCorrect={false} placeholder={zh ? '搜索完整历史' : 'Search full history'} placeholderTextColor="#888888" style={[w.input, { color }]} />
    <View style={w.tabs}>{Object.entries(labels).map(([id, label]) => <TouchableOpacity key={id} testID={`codex-search-kind-${id}`} onPress={() => setKind(id)} style={[w.tab, { backgroundColor: kind === id ? '#8b5cf6' : card }]}><Text style={{ color: kind === id ? '#ffffff' : color }}>{label}</Text></TouchableOpacity>)}</View>
    {!!error && <Text style={w.error}>{error}</Text>}
    {busy && <ActivityIndicator color="#8b5cf6" />}
    <Text testID="codex-search-count" style={w.hint}>{page ? `${page.total} ${zh ? '条结果 · 点击定位' : 'results · tap to locate'}` : zh ? '覆盖未加载到手机的历史消息和工具输出' : 'Includes older messages and tool output'}</Text>
    <FlatList keyboardShouldPersistTaps="handled" data={page?.results || []} keyExtractor={result => result.messageId}
      renderItem={({ item }) => <TouchableOpacity testID={`codex-search-result-${item.messageId}`} style={[w.row, { backgroundColor: card }]} onPress={() => { Keyboard.dismiss(); onSelect(item) }}>
        <Text style={w.accent}>{labels[item.kind]}</Text><Text style={{ color, marginTop: 6 }}>{item.snippet}</Text>
      </TouchableOpacity>}
      ListEmptyComponent={!busy && page ? <Text style={w.hint}>{zh ? '没有匹配结果' : 'No matches'}</Text> : null}
      ListFooterComponent={page?.nextOffset != null ? <TouchableOpacity disabled={busy} onPress={more} testID="codex-search-more" style={w.button}><Text style={w.accent}>{zh ? '加载更多结果' : 'More results'}</Text></TouchableOpacity> : null} />
  </CodexWorkbenchModal>
}
