import type { ReactNode } from "react"
import { Modal, Text, TouchableOpacity, View, StyleSheet, KeyboardAvoidingView, Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"

export function CodexWorkbenchModal({ visible, title, isDark, onClose, children }: { visible: boolean; title: string; isDark: boolean; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const { i18n } = useTranslation()
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[w.root, { backgroundColor: isDark ? '#141414' : '#ffffff', paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
      <View style={w.header}><Text style={[w.title, { color: isDark ? '#eeeeee' : '#171717' }]}>{title}</Text>
        <TouchableOpacity testID="codex-workbench-close" onPress={onClose} style={w.button}><Text style={w.accent}>{i18n.language.startsWith('zh') ? '完成' : 'Done'}</Text></TouchableOpacity>
      </View>
      {children}
    </KeyboardAvoidingView>
  </Modal>
}
export const w = StyleSheet.create({
  root: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  title: { flex: 1, fontSize: 20, fontWeight: '700' }, button: { padding: 12 }, accent: { color: '#8b5cf6', fontSize: 15, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 7, padding: 12 }, tab: { flex: 1, padding: 10, borderRadius: 9, alignItems: 'center' },
  input: { marginHorizontal: 16, borderWidth: 1, borderColor: '#aaaaaa', borderRadius: 10, padding: 12, fontSize: 16 },
  hint: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 12, color: '#888888' }, error: { margin: 16, color: '#dc4545' },
  row: { padding: 14, marginHorizontal: 12, marginVertical: 4, borderRadius: 10 }, rowTitle: { fontSize: 15, fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
})
