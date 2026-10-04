import { useEffect, useState } from "react"
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import type { Client, Session } from "../../lib/sdk"
import { codexContextUsage, codexError, type CodexLimits, type CodexOptions, type CodexSettingsPatch } from "../../lib/codex"

export type CodexTab = "status" | "effort" | "permissions" | "mode"

interface Props {
  visible: boolean
  tab: CodexTab
  session: Session | null
  client: Client | null
  isDark: boolean
  busy: boolean
  onFork: () => void
  forking: boolean
  onClose: () => void
  onSession: (session: Session) => void
}

export function CodexControls({ visible, tab: initialTab, session, client, isDark, busy, onClose, onSession, onFork, forking }: Props) {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith("zh")
  const tr = (cn: string, en: string) => zh ? cn : en
  const insets = useSafeAreaInsets()
  const [tab, setTab] = useState<CodexTab>(initialTab)
  const [options, setOptions] = useState<CodexOptions | null>(null)
  const [limits, setLimits] = useState<CodexLimits | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [diff, setDiff] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const control = session?.codex
  const context = codexContextUsage(control?.tokenUsage ?? null)
  const color = isDark ? "#eeeeee" : "#171717"
  const muted = isDark ? "#aaaaaa" : "#666666"
  const cardColor = isDark ? "#252525" : "#f2f3f5"
  const selectedModel = options?.models.find(model => model.id === control?.model)
  const locked = pending || !control?.canAcceptDirectInput

  useEffect(() => { if (visible) setTab(initialTab) }, [visible, initialTab])
  useEffect(() => {
    if (!visible || !client || !session?.id) return
    let active = true
    setLoading(true); setError(""); setOptions(null); setLimits(null); setDiff(null)
    Promise.allSettled([client.codex.options(), client.codex.limits(), client.session.get(session.id)]).then(results => {
      if (!active) return
      const [catalog, account, current] = results
      if (catalog.status === "fulfilled") setOptions(catalog.value)
      else setError(codexError(catalog.reason))
      if (account.status === "fulfilled") setLimits(account.value)
      if (current.status === "fulfilled") onSession(current.value)
      else setError(codexError(current.reason))
      setLoading(false)
    })
    return () => { active = false }
  }, [visible, client, session?.id, refresh, onSession])

  const run = async (action: () => Promise<Session>) => {
    setPending(true); setError("")
    try { onSession(await action()) } catch (e) { setError(codexError(e)) }
    finally { setPending(false) }
  }
  const update = (patch: CodexSettingsPatch) => {
    if (!client || !session || locked) return
    const apply = () => { void run(() => client.codex.update(session.id, patch)) }
    if (patch.permissions === ":danger-full-access" || patch.approvalPolicy === "never") {
      Alert.alert(tr("确认权限变更", "Confirm permission change"), patch.permissions
        ? tr("Codex 将能访问工作区以外的文件并执行命令。", "Codex will be able to access files outside the workspace and run commands.")
        : tr("后续操作将不再请求人工审批，仍受所选沙箱限制。", "Later actions will not ask for approval. The selected sandbox still applies."),
        [{ text: tr("取消", "Cancel"), style: "cancel" }, { text: tr("应用", "Apply"), style: "destructive", onPress: apply }])
    } else apply()
  }
  const heading = (text: string) => <Text style={[s.heading, { color }]}>{text}</Text>
  const line = (label: string, value: string, testID?: string) => (
    <View style={s.line} key={label}><Text style={{ color: muted }}>{label}</Text><Text testID={testID} selectable style={[s.value, { color }]}>{value}</Text></View>
  )
  const choice = (id: string, label: string, description: string, active: boolean, action: () => void, disabled = false) => (
    <TouchableOpacity key={id} testID={id} accessibilityRole="radio" accessibilityState={{ checked: active, disabled: locked || disabled }}
      disabled={locked || disabled} onPress={action} style={[s.choice, { backgroundColor: cardColor, borderColor: active ? "#8b5cf6" : "transparent", opacity: disabled ? 0.45 : 1 }]}>
      <Text style={[s.choiceTitle, { color }]}>{active ? "✓  " : ""}{label}</Text>
      {!!description && <Text style={[s.description, { color: muted }]}>{description}</Text>}
    </TouchableOpacity>
  )
  const effortDescriptions: Record<string, string> = {
    none: tr("关闭额外推理", "No additional reasoning"), minimal: tr("最少推理", "Minimal reasoning"),
    low: tr("响应更快，推理较少", "Faster responses with lighter reasoning"),
    medium: tr("平衡速度与推理深度", "Balances speed and reasoning depth"),
    high: tr("适合复杂问题", "Deeper reasoning for complex tasks"),
    xhigh: tr("更深入地推理复杂问题", "Extra-high reasoning depth"),
    max: tr("最高推理深度", "Maximum reasoning depth"),
    ultra: tr("最高推理深度，并允许自动委派子任务", "Maximum reasoning with automatic task delegation"),
  }
  const profileNames: Record<string, string> = { ":read-only": tr("只读", "Read only"), ":workspace": tr("工作区", "Workspace"), ":danger-full-access": tr("完全访问", "Full access") }
  const profileDescriptions: Record<string, string> = {
    ":read-only": tr("读取文件；修改和受限操作需要额外权限。", "Read files; writes and restricted actions require additional permission."),
    ":workspace": tr("允许修改工作区内的文件，其他访问受沙箱限制。", "Allow workspace edits; other access stays sandboxed."),
    ":danger-full-access": tr("允许访问工作区以外的文件并执行命令。", "Allow file access and commands outside the workspace."),
  }
  const approvalNames: Record<string, string> = { untrusted: tr("不可信操作先审批", "Ask for untrusted actions"), "on-request": tr("按需审批", "Ask when needed"), never: tr("不请求审批", "Never ask") }
  const effortRows = selectedModel?.efforts ?? []

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: isDark ? "#141414" : "#ffffff", paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
        <View style={s.header}>
          <Text style={[s.title, { color }]}>{tr("Codex 会话", "Codex session")}</Text>
          <TouchableOpacity testID="codex-controls-close" onPress={onClose} style={s.headerButton}><Text style={{ color: "#8b5cf6", fontSize: 16 }}>{tr("完成", "Done")}</Text></TouchableOpacity>
        </View>
        <View style={s.tabs}>
          {([['status', tr('状态', 'Status')], ['effort', tr('推理', 'Effort')], ['permissions', tr('权限', 'Permissions')], ['mode', tr('模式', 'Mode')]] as const).map(([id, label]) => (
            <TouchableOpacity key={id} testID={`codex-tab-${id}`} onPress={() => setTab(id)} style={[s.tab, { backgroundColor: tab === id ? '#8b5cf6' : cardColor }]}>
              <Text style={{ color: tab === id ? '#ffffff' : color }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {(loading || pending) && <ActivityIndicator style={{ marginVertical: 8 }} color="#8b5cf6" />}
        {!!error && <Text testID="codex-controls-error" style={s.error}>{error}</Text>}
        <ScrollView contentContainerStyle={s.body}>
          {tab === 'status' && <>
            <TouchableOpacity testID="codex-fork-current" disabled={locked || busy || forking || control?.compacting || control?.runtimeStatus === 'active'} onPress={onFork} style={[s.button, { opacity: locked || busy || forking || control?.compacting || control?.runtimeStatus === 'active' ? 0.45 : 1 }]}><Text style={s.buttonText}>{forking ? tr('正在创建分支…', 'Creating fork…') : tr('从当前进度创建分支', 'Fork from current progress')}</Text></TouchableOpacity>
            <Text style={[s.description, { color: muted }]}>{tr('保留原会话，在新分支继续；两个会话共用工作目录和文件。运行中的任务结束后可用。', 'Keep the original conversation and continue in a new branch. Both sessions share the directory and files. Available after the current turn finishes.')}</Text>
            {heading(tr('当前设置', 'Current settings'))}
            {line(tr('模型', 'Model'), control?.model || '—', 'codex-current-model')}
            {line(tr('推理强度', 'Reasoning effort'), control?.effort || tr('模型默认', 'Model default'), 'codex-current-effort')}
            {line(tr('权限', 'Permissions'), profileNames[control?.permissionProfile || ''] || control?.permissionProfile || control?.sandboxPolicy?.type || '—')}
            {line(tr('审批', 'Approvals'), typeof control?.approvalPolicy === 'string' ? approvalNames[control.approvalPolicy] || control.approvalPolicy : tr('自定义', 'Custom'))}
            {line(tr('工作目录', 'Working directory'), session?.directory || '—')}
            {heading(tr('上下文用量', 'Context usage'))}
            <View testID="codex-context" style={[s.card, { backgroundColor: cardColor }]}>
              <Text testID="codex-context-value" style={[s.context, { color }]}>{context ? `${context.used.toLocaleString()}${context.limit ? ` / ${context.limit.toLocaleString()}` : ''} tokens${context.percent !== null ? ` · ${context.percent}%` : ''}` : tr('等待服务器上报用量', 'Waiting for usage from the server')}</Text>
              {context?.percent !== null && context?.percent !== undefined && <View style={s.track}><View style={[s.fill, { width: `${Math.min(100, context.percent)}%` }]} /></View>}
              {control?.tokenUsage && <>
                {control.tokenUsage.last.inputTokens + control.tokenUsage.last.outputTokens > 0 ? <>
                {line(tr('输入', 'Input'), control.tokenUsage.last.inputTokens.toLocaleString())}
                {line(tr('缓存输入（含在输入中）', 'Cached input (included above)'), control.tokenUsage.last.cachedInputTokens.toLocaleString())}
                {line(tr('输出', 'Output'), control.tokenUsage.last.outputTokens.toLocaleString())}
                {line(tr('推理（含在输出中）', 'Reasoning (included in output)'), control.tokenUsage.last.reasoningOutputTokens.toLocaleString())}
                </> : <Text style={{ color: muted }}>{tr('压缩后的上下文估算，由服务器提供。', 'Context estimate after compaction, reported by the server.')}</Text>}
                {line(tr('会话累计', 'Session total'), control.tokenUsage.total.totalTokens.toLocaleString())}
              </>}
            </View>
            <TouchableOpacity testID="codex-compact" disabled={locked || busy || control?.compacting || control?.runtimeStatus === 'active'}
              onPress={() => { if (client && session) void run(() => client.codex.compact(session.id)) }}
              style={[s.button, { opacity: locked || busy || control?.compacting || control?.runtimeStatus === 'active' ? 0.45 : 1 }]}>
              <Text style={s.buttonText}>{control?.compacting ? tr('正在压缩…', 'Compacting…') : tr('压缩上下文 /compact', 'Compact context /compact')}</Text>
            </TouchableOpacity>
            <Text style={[s.description, { color: muted }]}>{tr('压缩会话上下文，保留继续任务所需的关键信息。运行中的任务结束后可用。', 'Summarize context while preserving the working state. Available after the current turn finishes.')}</Text>
            {heading(tr('套餐用量', 'Plan usage'))}
            {limits ? Object.entries(limits.rateLimitsByLimitId || { codex: limits.rateLimits }).map(([key, limit]) => <View key={key} style={[s.card, { backgroundColor: cardColor }]}>
              <Text style={[s.choiceTitle, { color }]}>{limit.limitName || key}</Text>
              {[limit.primary, limit.secondary].filter(Boolean).map((window, i) => <View key={i}>
                {line(window!.windowDurationMins ? `${window!.windowDurationMins / 60}h` : tr('用量窗口', 'Usage window'), `${window!.usedPercent}% ${tr('已使用', 'used')}`)}
                {!!window!.resetsAt && <Text style={[s.description, { color: muted }]}>{tr('重置时间：', 'Resets: ')}{new Date(window!.resetsAt * 1000).toLocaleString()}</Text>}
              </View>)}
            </View>) : <Text style={{ color: muted }}>{tr('服务器暂未提供套餐用量', 'Plan usage is unavailable from the server')}</Text>}
            {!!control?.plan?.steps.length && <>
              {heading(tr('任务计划', 'Task plan'))}
              {control.plan.steps.map((step, i) => <Text key={i} style={{ color }}>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '○'} {step.step}</Text>)}
            </>}
            <TouchableOpacity testID="codex-show-diff" style={[s.choice, { backgroundColor: cardColor }]} onPress={async () => {
              if (!client || !session) return
              try { setDiff((await client.codex.diff(session.id)).diff) } catch (e) { setError(codexError(e)) }
            }}><Text style={{ color }}>{tr('查看最近文件差异', 'View recent file diff')}</Text></TouchableOpacity>
            {diff !== null && <Text selectable style={[s.diff, { color }]}>{diff || tr('暂无文件差异', 'No file diff available')}</Text>}
            {!!control?.instructionSources.length && <>
              {heading(tr('已加载的指令文件', 'Loaded instruction files'))}
              {control.instructionSources.map(path => <Text key={path} selectable style={{ color: muted }}>{path}</Text>)}
            </>}
          </>}
          {tab === 'effort' && <>
            {heading(selectedModel?.name || control?.model || tr('推理强度', 'Reasoning effort'))}
            <Text style={{ color: muted }}>{tr('选择后立即保存到当前会话，后续轮次使用此设置。', 'Changes are saved to this session and apply to subsequent turns.')}</Text>
            {effortRows.map(option => choice(`codex-effort-${option.reasoningEffort}`, option.reasoningEffort,
              effortDescriptions[option.reasoningEffort] || option.description, control?.effort === option.reasoningEffort,
              () => update({ effort: option.reasoningEffort })))}
            {!!selectedModel && choice('codex-effort-default', tr('恢复模型默认值', 'Restore model default'), selectedModel.defaultEffort,
              false, () => update({ effort: 'default' }))}
          </>}
          {tab === 'permissions' && <>
            {heading(tr('文件和命令权限', 'File and command permissions'))}
            {options?.permissionProfiles.map(profile => choice(`codex-permission-${profile.id.replace(/^:/, '')}`, profileNames[profile.id] || profile.id,
              profile.description || profileDescriptions[profile.id] || profile.id, control?.permissionProfile === profile.id,
              () => update({ permissions: profile.id }), !profile.allowed))}
            {heading(tr('审批策略', 'Approval policy'))}
            {options?.approvalPolicies.map(policy => choice(`codex-approval-${policy}`, approvalNames[policy] || policy, '', control?.approvalPolicy === policy,
              () => update({ approvalPolicy: policy })))}
            {line(tr('实际沙箱', 'Effective sandbox'), control?.sandboxPolicy?.type || '—', 'codex-effective-sandbox')}
            {line(tr('网络访问', 'Network access'), control?.sandboxPolicy?.type === 'dangerFullAccess' ? tr('允许', 'Allowed') : String(control?.sandboxPolicy?.networkAccess ?? '—'))}
            {!!control?.sandboxPolicy?.writableRoots?.length && <Text selectable style={{ color: muted }}>{control.sandboxPolicy.writableRoots.join('\n')}</Text>}
          </>}
          {tab === 'mode' && <>
            {heading(tr('协作模式', 'Collaboration mode'))}
            {options?.modes.map(mode => choice(`codex-mode-${mode}`, mode === 'plan' ? tr('计划', 'Plan') : tr('执行', 'Default'),
              mode === 'plan' ? tr('先分析并制定计划。', 'Analyze the task and prepare a plan.') : tr('按照当前权限执行任务。', 'Carry out tasks under the current permissions.'),
              control?.mode === mode, () => update({ mode })))}
          </>}
          <TouchableOpacity testID="codex-refresh" style={[s.choice, { backgroundColor: cardColor }]} onPress={() => setRefresh(value => value + 1)}><Text style={{ color }}>{tr('刷新服务端状态', 'Refresh server state')}</Text></TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  root: { flex: 1 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18 },
  title: { fontSize: 21, fontWeight: '700' }, headerButton: { padding: 12 }, tabs: { flexDirection: 'row', gap: 8, padding: 16 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' }, body: { padding: 18, paddingBottom: 32, gap: 12 },
  heading: { fontSize: 17, fontWeight: '600', marginTop: 8 }, line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  value: { flexShrink: 1, textAlign: 'right' }, choice: { padding: 14, borderRadius: 12, borderWidth: 2 },
  choiceTitle: { fontSize: 16, fontWeight: '600' }, description: { fontSize: 13, lineHeight: 19, marginTop: 4 },
  card: { padding: 14, borderRadius: 12, gap: 5 }, context: { fontSize: 18, fontWeight: '600' }, track: { height: 6, borderRadius: 3, backgroundColor: '#bbbbbb', overflow: 'hidden', marginVertical: 8 },
  fill: { height: 6, backgroundColor: '#8b5cf6' }, button: { padding: 14, backgroundColor: '#8b5cf6', borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' }, error: { color: '#d54343', marginHorizontal: 18, marginVertical: 8 },
  diff: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
})
