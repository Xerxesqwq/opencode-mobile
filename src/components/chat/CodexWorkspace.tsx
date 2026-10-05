import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, AppState, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useTranslation } from "react-i18next"
import type { Client, Session } from "../../lib/sdk"
import { codexError, type CodexTaskState } from "../../lib/codex"
import { CodexWorkbenchModal, w } from "./CodexWorkbenchModal"

type Task = Awaited<ReturnType<Client['codex']['tasks']>>['items'][number]
type Tab = 'tasks' | 'sessions' | 'archived'
export function CodexWorkspace({ visible, initialTab, client, isDark, onClose, onOpen, onChanged }: { visible: boolean; initialTab: Tab; client: Client | null; isDark: boolean; onClose: () => void; onOpen: (session: Session) => void; onChanged: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [tab, setTab] = useState<Tab>(initialTab), [query, setQuery] = useState(''), [filter, setFilter] = useState('active')
  const [tasks, setTasks] = useState<Task[]>([]), [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set()), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [updated, setUpdated] = useState<number>()
  const generation = useRef(0), running = useRef<number | null>(null)
  const color = isDark ? '#eeeeee' : '#171717', card = isDark ? '#252525' : '#f2f3f5'
  const labels: Record<CodexTaskState, string> = zh ? { running: '运行中', approval: '待审批', input: '待回答', failed: '失败', completed: '已完成', interrupted: '已停止', idle: '空闲' } : { running: 'Running', approval: 'Approval needed', input: 'Input needed', failed: 'Failed', completed: 'Completed', interrupted: 'Stopped', idle: 'Idle' }
  useEffect(() => { if (visible) { setTab(initialTab); setSelected(new Set()); setError(''); setNotice('') } }, [visible, initialTab])
  const load = useCallback(async () => {
    if (!visible || !client || running.current === generation.current || AppState.currentState !== 'active') return
    const epoch = generation.current
    running.current = epoch; setLoading(true)
    try {
      if (tab === 'tasks') {
        const result = await client.codex.tasks()
        if (epoch === generation.current) { setTasks(result.items); setUpdated(result.updatedAt); setError('') }
      } else {
        const result = await client.codex.library(tab === 'archived')
        if (epoch === generation.current) { setSessions(result); setError('') }
      }
    } catch (e) { if (epoch === generation.current) setError(codexError(e)) }
    finally { if (running.current === epoch) running.current = null; if (epoch === generation.current) setLoading(false) }
  }, [client, tab, visible])
  useEffect(() => {
    generation.current++; setSelected(new Set()); setNotice(''); setQuery(''); setSessions([]); setLoading(false)
    void load()
    const timer = setInterval(() => { void load() }, tab === 'tasks' ? 5000 : 15000)
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void load() })
    return () => { generation.current++; clearInterval(timer); listener.remove() }
  }, [load, tab])
  const archive = async (ids: string[], archived: boolean) => {
    if (!client || busy || !ids.length) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.codex.archive(ids, archived)
      const failed = result.results.filter(item => !item.ok)
      setSelected(new Set(failed.map(item => item.id)))
      setError(failed.map(item => `${sessions.find(session => session.id === item.id)?.title || item.id}: ${item.error}`).join('\n'))
      setNotice(zh ? `${result.results.length - failed.length} 个会话已${archived ? '归档' : '恢复'}` : `${result.results.length - failed.length} sessions ${archived ? 'archived' : 'restored'}`)
      const resultSessions = await client.codex.library(tab === 'archived')
      setSessions(resultSessions); onChanged()
    } catch (e) { setError(codexError(e)) }
    finally { setBusy(false) }
  }
  const stop = (task: Task) => Alert.alert(zh ? '停止任务？' : 'Stop task?', task.session.title, [
    { text: zh ? '取消' : 'Cancel', style: 'cancel' },
    { text: zh ? '停止' : 'Stop', style: 'destructive', onPress: async () => {
      if (!client) return
      try { await client.session.abort(task.session.id); await load() } catch (e) { setError(codexError(e)) }
    } },
  ])
  const shownTasks = useMemo(() => tasks.filter(task => {
    const status = filter === 'all' || (filter === 'active' ? ['running', 'approval', 'input'].includes(task.state) : task.state === 'failed')
    return status && `${task.session.title} ${task.session.directory}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  }), [tasks, filter, query])
  const shownSessions = sessions.filter(session => `${session.title} ${session.directory}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id); return next })
  return <CodexWorkbenchModal visible={visible} title={zh ? '任务与会话' : 'Tasks & sessions'} isDark={isDark} onClose={() => { if (!busy) onClose() }}>
    <View style={w.tabs}>{([['tasks', zh ? '任务' : 'Tasks'], ['sessions', zh ? '整理' : 'Manage'], ['archived', zh ? '已归档' : 'Archived']] as const).map(([id, label]) => <TouchableOpacity testID={`codex-workspace-${id}`} key={id} disabled={busy} onPress={() => setTab(id)} style={[w.tab, { backgroundColor: tab === id ? '#8b5cf6' : card }]}><Text style={{ color: tab === id ? '#ffffff' : color }}>{label}</Text></TouchableOpacity>)}</View>
    <TextInput testID="codex-library-search" value={query} editable={!busy} onChangeText={text => { setQuery(text); setSelected(new Set()) }} placeholder={zh ? '筛选标题或目录' : 'Filter title or directory'} placeholderTextColor="#888888" style={[w.input, { color }]} />
    {tab === 'tasks' ? <View style={w.tabs}>{[['active', zh ? '进行中' : 'Active'], ['failed', zh ? '失败' : 'Failed'], ['all', zh ? '全部' : 'All']].map(([id, label]) => <TouchableOpacity testID={`codex-task-filter-${id}`} key={id} style={[w.tab, { backgroundColor: filter === id ? '#8b5cf6' : card }]} onPress={() => setFilter(id)}><Text style={{ color: filter === id ? '#ffffff' : color }}>{label}</Text></TouchableOpacity>)}</View>
      : <View style={w.line}><TouchableOpacity disabled={busy} testID="codex-library-select-all" style={w.button} onPress={() => setSelected(new Set(selected.size ? [] : shownSessions.slice(0, 100).map(session => session.id)))}><Text style={w.accent}>{selected.size ? (zh ? '取消选择' : 'Clear selection') : (zh ? '选择当前结果' : 'Select results')}</Text></TouchableOpacity><Text style={w.hint}>{selected.size} / 100</Text></View>}
    {(loading || busy) && <ActivityIndicator color="#8b5cf6" />}
    {!!error && <Text testID="codex-workspace-error" style={w.error}>{error}</Text>}{!!notice && <Text testID="codex-library-notice" style={w.hint}>{notice}</Text>}
    {tab === 'tasks' ? <>
      <Text style={w.hint}>{zh ? '全部已加载任务及最近 100 个会话 · 每 5 秒刷新' : 'All loaded tasks and 100 recent sessions · refreshes every 5s'}{updated ? ` · ${new Date(updated).toLocaleTimeString()}` : ''}</Text>
      <FlatList data={shownTasks} keyExtractor={task => task.session.id} onRefresh={load} refreshing={loading && tasks.length > 0}
        ListEmptyComponent={!loading ? <Text style={w.hint}>{zh ? '当前筛选下没有任务' : 'No tasks match this filter'}</Text> : null}
        renderItem={({ item }) => <View testID={`codex-task-${item.session.id}`} style={[w.row, { backgroundColor: card }]}>
          <TouchableOpacity onPress={() => onOpen(item.session)}><Text style={[w.rowTitle, { color }]}>{item.session.title}</Text><Text style={{ color: '#888888', marginTop: 6 }}>{item.session.directory}</Text></TouchableOpacity>
          <View style={w.line}><Text testID={`codex-task-state-${item.session.id}`} style={{ color: item.state === 'failed' ? '#dc4545' : '#8b5cf6', marginTop: 8 }}>{item.statusUnavailable ? (zh ? '状态暂不可用' : 'Status unavailable') : labels[item.state]}</Text>{item.canStop && <TouchableOpacity testID={`codex-task-stop-${item.session.id}`} style={w.button} onPress={() => stop(item)}><Text style={{ color: '#dc4545' }}>{zh ? '停止' : 'Stop'}</Text></TouchableOpacity>}</View>
          {!!item.error && <Text style={{ color: '#dc4545', fontSize: 12 }}>{item.error}</Text>}
        </View>} />
    </> : <>
      <FlatList data={shownSessions} keyExtractor={session => session.id} keyboardShouldPersistTaps="handled" onRefresh={load} refreshing={loading && sessions.length > 0}
        ListEmptyComponent={!loading ? <Text style={w.hint}>{zh ? '没有匹配的会话' : 'No matching sessions'}</Text> : null}
        renderItem={({ item }) => <View style={[w.row, { backgroundColor: card }]}>
          <View style={w.line}><TouchableOpacity testID={`codex-library-select-${item.id}`} disabled={busy} onPress={() => toggle(item.id)} accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(item.id) }} style={w.button}><Text style={w.accent}>{selected.has(item.id) ? '☑' : '☐'}</Text></TouchableOpacity>
            <TouchableOpacity style={{ flex: 1 }} disabled={tab === 'archived' || busy} onPress={() => onOpen(item)}><Text style={[w.rowTitle, { color }]}>{item.title}</Text><Text style={{ color: '#888888', marginTop: 5 }}>{item.directory}</Text></TouchableOpacity>
          </View>
          <TouchableOpacity testID={`codex-library-action-${item.id}`} disabled={busy} onPress={() => archive([item.id], tab !== 'archived')} style={w.button}><Text style={w.accent}>{tab === 'archived' ? (zh ? '恢复会话' : 'Restore session') : (zh ? '归档' : 'Archive')}</Text></TouchableOpacity>
        </View>} />
      <TouchableOpacity testID="codex-library-batch" disabled={!selected.size || busy} onPress={() => archive([...selected], tab !== 'archived')} style={{ padding: 16, margin: 12, borderRadius: 10, backgroundColor: selected.size && !busy ? '#8b5cf6' : '#aaaaaa' }}><Text style={{ color: '#ffffff', textAlign: 'center', fontWeight: '600' }}>{tab === 'archived' ? (zh ? '恢复所选' : 'Restore selected') : (zh ? '归档所选' : 'Archive selected')} ({selected.size})</Text></TouchableOpacity>
    </>}
  </CodexWorkbenchModal>
}
