import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native"
import { useTranslation } from "react-i18next"
import type { ServerBackend } from "../lib/types"

export function BackendPicker({ value, onChange }: { value: ServerBackend; onChange: (value: ServerBackend) => void }) {
  const dark = useColorScheme() === "dark"
  const { i18n } = useTranslation()
  const chinese = i18n.language.startsWith("zh")
  const color = dark ? "#ffffff" : "#171717"
  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color }]}>{chinese ? "服务" : "Service"}</Text>
      <View style={styles.row}>
        {(["opencode", "codex"] as const).map(backend => (
          <TouchableOpacity key={backend} testID={`backend-${backend}`} accessibilityRole="radio"
            accessibilityState={{ checked: value === backend }} onPress={() => onChange(backend)}
            style={[styles.option, { borderColor: value === backend ? "#3b82f6" : "#888888" }]}>
            <Text style={{ color }}>{backend === "codex" ? "Codex" : "OpenCode"}{value === backend ? " ✓" : ""}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {value === "codex" && <Text style={[styles.hint, { color }]}>{chinese
        ? "连接服务器上的 Codex 网关。可打开已有会话或创建新会话，使用服务器的 Codex 登录。"
        : "Connect to your Codex gateway. Open existing sessions or create new ones using the server’s Codex login."}</Text>}
    </View>
  )
}
const styles = StyleSheet.create({
  container: { marginBottom: 20 }, label: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  row: { flexDirection: "row", gap: 12 }, option: { flex: 1, padding: 14, borderWidth: 2, borderRadius: 10, alignItems: "center" },
  hint: { marginTop: 10, fontSize: 13, lineHeight: 19, opacity: 0.75 },
})
