import { queueCodexDraft, takeCodexDraft } from "../../src/lib/codex-drafts"
import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native"
import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import * as ImagePicker from "expo-image-picker"
import * as ImageManipulator from "expo-image-manipulator"
import * as Clipboard from "expo-clipboard"
import type BottomSheet from "@gorhom/bottom-sheet"
import {
  MessageBubble,
  PermissionPrompt,
  QuestionPrompt,
  StatusIndicator,
  SlashPopover,
  ModelPicker,
  VariantPicker,
  ImageAttachments,
  SessionInfo,
  type SlashCommand,
  type Attachment,
} from "../../src/components/chat"
import { useSessions } from "../../src/stores/sessions"
import { useEvents, refreshPending } from "../../src/stores/events"
import { useConnections } from "../../src/stores/connections"
import { useAuth } from "../../src/stores/auth"
import { useCatalog } from "../../src/stores/catalog"
import { CodexSearch } from "../../src/components/chat/CodexSearch"
import { CodexFiles } from "../../src/components/chat/CodexFiles"
import type { CodexSearchResult } from "../../src/lib/codex"
import { CodexControls, type CodexTab } from "../../src/components/chat/CodexControls"
import { codexError } from "../../src/lib/codex"
import type { Session } from "../../src/lib/sdk"
import { useSpeech } from "../../src/lib/speech"

// --- Builtin slash commands ---
const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    trigger: "new",
    title: "New Session",
    description: "Start a new session",
    icon: "add-circle-outline",
    type: "builtin",
  },
  {
    trigger: "model",
    title: "Switch Model",
    description: "Choose a different model",
    icon: "hardware-chip-outline",
    type: "builtin",
  },
  {
    trigger: "agent",
    title: "Switch Agent",
    description: "Cycle to next agent",
    icon: "person-outline",
    type: "builtin",
  },
]

const CODEX_COMMANDS: SlashCommand[] = [
  ["compact", "Compact context"], ["effort", "Reasoning effort"],
  ["permissions", "Permissions"], ["status", "Codex status"],
  ["context", "Context usage"], ["plan", "Plan / Default mode"],
].map(([trigger, title]) => ({ trigger, title, icon: "options-outline", type: "builtin" }))

function getShortDir(dir?: string): string | null {
  if (!dir) return null
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] || null
}

export default function SessionScreen() {
  const { id, directory } = useLocalSearchParams<{ id: string; directory?: string }>()
  const router = useRouter()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const insets = useSafeAreaInsets()
  const keyboardContainerRef = useRef<View>(null)
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    if (Platform.OS !== "android") return
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true))
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith("zh")

  const flatListRef = useRef<FlatList>(null)
  const modelSheetRef = useRef<BottomSheet>(null)
  const variantSheetRef = useRef<BottomSheet>(null)
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showInfo, setShowInfo] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [searchJump, setSearchJump] = useState(0)
  const [targetMessage, setTargetMessage] = useState<string | null>(null)
  const [forkingCodex, setForkingCodex] = useState(false)
  const forkingRef = useRef(false)
  const [revertingCodex, setRevertingCodex] = useState(false)
  const revertingRef = useRef(false)
  const jumpRetries = useRef(0)

  const {
    currentSession,
    messages,
    parts,
    isLoading,
    loadingMore,
    hasMore,
    selectSession,
    sendMessage,
    abortSession,
    loadOlderMessages,
    revertToMessage,
    unrevertSession,
  } = useSessions()

  // Derive sending state for this specific session
  const isSending = useSessions((s) => !!(currentSession && s.sending[currentSession.id]))

  const { authenticateForMessage } = useAuth()
  const { client, clientForDirectory, activeConnection } = useConnections()

  const isCodex = activeConnection?.backend === "codex"
  const [codexTab, setCodexTab] = useState<CodexTab>("status")
  const [showCodex, setShowCodex] = useState(false)
  const openCodex = useCallback((tab: CodexTab) => {
    Keyboard.dismiss(); setCodexTab(tab); setShowCodex(true)
  }, [])
  const updateCodexSession = useCallback((session: Session) => {
    useSessions.getState().handleEvent({ type: "session.updated", properties: { info: session } })
  }, [])

  // Use directory-aware client for sessions that belong to a project other than the active one
  const sessionClient = useMemo(
    () => (currentSession?.directory ? (clientForDirectory(currentSession.directory) ?? client) : client),
    [currentSession?.directory, clientForDirectory, client],
  )

  // Catalog
  const catalog = useCatalog()
  const agents = Array.isArray(catalog.agents) ? catalog.agents : []
  const serverCommands = Array.isArray(catalog.commands) ? catalog.commands : []
  const providers = Array.isArray(catalog.providers) ? catalog.providers : []
  const agent = catalog.agent || ""
  const model = catalog.model
  const setModel = catalog.setModel
  const variant = catalog.variant
  const setVariant = catalog.setVariant
  const cycleAgent = catalog.cycleAgent

  // Permission & question state
  const sessionID = currentSession?.id
  const permissions = useEvents((s) => (sessionID ? s.permissions[sessionID] : undefined)) || []
  const questions = useEvents((s) => (sessionID ? s.questions[sessionID] : undefined)) || []

  const shortDir = getShortDir(currentSession?.directory)
  const [showScrollButton, setShowScrollButton] = useState(false)

  // SSE reconnect banner
  const reconnectAttempts = useEvents((s) => s.reconnectAttempts)
  const [showConnectedFlash, setShowConnectedFlash] = useState(false)
  const prevReconnecting = useRef(false)

  // Voice input — transcript appends to the text input on completion
  const speech = useSpeech(
    useCallback((text: string) => {
      setInput((prev) => (prev ? prev + " " + text : text))
    }, []),
  )

  // Surface speech recognition failures (e.g. mic permission denied). Keyed
  // on the error value itself so it only fires once per distinct error, not
  // on every re-render while it remains set.
  useEffect(() => {
    if (!speech.error) return
    Alert.alert(t("session.alerts.speechErrorTitle"), t("session.alerts.speechErrorMessage"))
  }, [speech.error, t])

  // Slash command state
  const slashActive = input.startsWith("/") && !input.includes(" ")
  const slashQuery = slashActive ? input.slice(1) : ""

  const allCommands = useMemo<SlashCommand[]>(() => {
    const custom: SlashCommand[] = serverCommands.map((cmd) => ({
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      icon: "code-slash-outline",
      type: "custom",
    }))
    return isCodex ? [...BUILTIN_COMMANDS.filter(command => command.trigger !== "agent"), ...CODEX_COMMANDS] : [...custom, ...BUILTIN_COMMANDS]
  }, [serverCommands, isCodex])

  // While a revert is pending, the reverted message and everything after it
  // still exist server-side (cleanup only runs on the next prompt/unrevert)
  // — hide them client-side so editing feels immediate. Message IDs are
  // lexicographically sortable, same comparison the TUI uses. Optimistic
  // "temp-" IDs (assigned client-side before the server responds, see
  // sendMessage) aren't part of that sort order — always keep them so a
  // message sent concurrently with a revert isn't hidden.
  const revertMessageID = currentSession?.revert?.messageID

  // Inverted FlatList: data is reversed (newest first) so newest renders at bottom
  const messageData = useMemo(
    () =>
      (messages || [])
        .filter((msg) => !revertMessageID || msg.id.startsWith("temp-") || msg.id < revertMessageID)
        .map((msg) => ({
          message: msg,
          parts: (parts && parts[msg.id]) || [],
        }))
        .reverse(),
    [messages, parts, revertMessageID],
  )

  const locateMessage = useCallback(async (result: CodexSearchResult) => {
    setShowSearch(false)
    if (!useSessions.getState().messages.some(message => message.id === result.messageId)) await loadOlderMessages()
    if (!useSessions.getState().messages.some(message => message.id === result.messageId)) {
      Alert.alert(zh ? "消息已改变" : "Message changed", zh ? "请刷新搜索结果后重试。" : "Refresh search results and try again.")
      return
    }
    jumpRetries.current = 0; setTargetMessage(result.messageId); setSearchJump(value => value + 1)
  }, [loadOlderMessages, zh])
  useEffect(() => {
    if (!targetMessage) return
    const index = messageData.findIndex(row => row.message.id === targetMessage)
    if (index >= 0) {
      const timer = setTimeout(() => flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 250)
      return () => clearTimeout(timer)
    }
  }, [targetMessage, messageData.length, searchJump])

  // Tracks the latest composer text without pulling `input` into
  // handleMessageLongPress's deps — kept as a plain ref assignment (not
  // state) so the callback below stays referentially stable across
  // keystrokes for MessageBubble's custom memo comparator.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const inputRef = useRef(input)
  inputRef.current = input

  useEffect(() => {
    const draft = takeCodexDraft(id)
    if (!draft) return
    setInput(draft.text)
    setAttachments(draft.images.map(uri => ({ uri, mime: uri.slice(5, uri.indexOf(";")), filename: "image" })))
    if (draft.omittedAttachments) Alert.alert("Codex", zh ? "请重新添加原提问中的文件附件。" : "Reattach the original file attachments before sending.")
  }, [id])

  const forkCodex = useCallback((messageID?: string) => {
    const current = useSessions.getState().currentSession
    const message = messageID ? useSessions.getState().messages.find(message => message.id === messageID) : undefined
    if (!current || !sessionClient || forkingRef.current || revertingRef.current || (messageID && !message?.codexTurnID)) return
    Keyboard.dismiss()
    Alert.alert(zh ? "创建会话分支？" : "Fork conversation?",
      (message ? (zh ? "新分支从这轮提问之前开始，原提问会放入新分支的输入框。" : "The branch starts before this prompt, which is placed in its composer.") : (zh ? "新分支会保留当前完整对话。" : "The branch keeps the full conversation so far.")) + (zh ? "原会话保持原样。两个会话共用当前工作目录和文件。" : " The original conversation stays intact. Both sessions share the current directory and files."), [
      { text: t("common.cancel"), style: "cancel" },
      { text: zh ? "创建分支" : "Create fork", onPress: async () => {
        if (forkingRef.current || revertingRef.current) return
        forkingRef.current = true; setForkingCodex(true)
        try {
          const result = await sessionClient.codex.fork(current.id, message?.codexTurnID)
          if (result.draft) queueCodexDraft(result.session.id, result.draft)
          setShowCodex(false)
          router.push({ pathname: "/session/[id]", params: { id: result.session.id, directory: result.session.directory } })
        } catch (error) { Alert.alert("Codex", codexError(error)) }
        finally { forkingRef.current = false; setForkingCodex(false) }
      } },
    ])
  }, [sessionClient, zh, t, router])

  const applyRevertResult = useCallback((result: Awaited<ReturnType<typeof revertToMessage>>) => {
    if (!result.ok) {
      if (result.reason === "unsupported") {
        Alert.alert(t("session.alerts.notSupportedTitle"), t("session.alerts.notSupportedMessage"))
      } else if (result.reason === "auth") {
        Alert.alert(t("session.alerts.revertAuthFailedTitle"), t("session.alerts.revertAuthFailedMessage"))
      } else {
        Alert.alert(t("session.alerts.editFailedTitle"), t("session.alerts.editFailedMessage"))
      }
      return
    }
    setInput(result.text)
    // Restore attachments in the same shape the composer's own picker
    // functions (pickFromLibrary/pickFromCamera/pasteFromClipboard) use.
    setAttachments(
      result.files
        .filter((f): f is typeof f & { url: string; mime: string } => !!f.url && !!f.mime)
        .map((f) => ({ uri: f.url, mime: f.mime, filename: f.filename })),
    )
  }, [t])

  // Stable across renders (reads fresh state via getState() rather than
  // closing over props) so MessageBubble's custom memo comparator can bail
  // safely without risking a stale handler.
  const handleMessageLongPress = useCallback((messageID: string) => {
    if (isCodex) {
      const message = useSessions.getState().messages.find(message => message.id === messageID)
      const current = useSessions.getState().currentSession
      if (!message?.codexTurnID || !current || !sessionClient || revertingRef.current || forkingRef.current) return
      Alert.alert(zh ? "回退并编辑这轮提问？" : "Rewind and edit this prompt?",
        (zh ? "会先保存完整备份，再移除这一轮及之后的对话。文件保持当前状态。原提问会放入输入框供你编辑。" : "A full backup will be saved before removing this turn and later conversation. Files keep their current state. The original prompt will be placed in the composer.") + ((inputRef.current.trim() || attachmentsRef.current.length) ? (zh ? "\n输入框中的未发送草稿将被替换。" : "\nYour unsent draft will be replaced.") : ""), [
        { text: t("common.cancel"), style: "cancel" },
        { text: zh ? "备份并回退" : "Back up & rewind", style: "destructive", onPress: async () => {
          if (revertingRef.current) return
          revertingRef.current = true; setRevertingCodex(true)
          try {
            const result = await sessionClient.codex.revert(current.id, message.codexTurnID!)
            await selectSession(current.id, current.directory)
            setTargetMessage(null); setInput(result.draft.text)
            setAttachments(result.draft.images.map(uri => ({ uri, mime: uri.slice(5, uri.indexOf(";")), filename: "image" })))
            const details = `${zh ? "备份：" : "Backup: "}${result.backup.title}${result.draft.omittedAttachments ? (zh ? "\n请重新添加原提问中的文件附件。" : "\nReattach the original file attachments before retrying.") : ""}`
            Alert.alert(zh ? "已回退，可以编辑后重试" : "Rewound. Edit the prompt to retry", details, [
              { text: zh ? "继续编辑" : "Edit prompt" },
              { text: zh ? "打开备份" : "Open backup", onPress: () => router.push({ pathname: "/session/[id]", params: { id: result.backup.id, directory: result.backup.directory } }) },
            ])
          } catch (error) { Alert.alert("Codex", codexError(error)) }
          finally { revertingRef.current = false; setRevertingCodex(false) }
        } },
      ])
      return
    }
    Alert.alert(t("session.alerts.messageActionsTitle"), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("session.actions.editMessage"),
        onPress: () => {
          const doRevert = async () => {
            const result = await useSessions.getState().revertToMessage(messageID)
            applyRevertResult(result)
          }
          // Editing overwrites the composer — don't silently clobber an
          // in-progress unsent draft.
          if (inputRef.current.trim()) {
            Alert.alert(
              t("session.alerts.replaceDraftTitle"),
              t("session.alerts.replaceDraftMessage"),
              [
                { text: t("common.cancel"), style: "cancel" },
                { text: t("session.actions.replace"), style: "destructive", onPress: doRevert },
              ],
              { cancelable: false },
            )
            return
          }
          doRevert()
        },
      },
    ])
  }, [applyRevertResult, t, isCodex, sessionClient, zh, selectSession, router])

  const scrollToBottom = useCallback((animated = true) => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated })
  }, [])

  // Re-select on every focus, not just mount. currentSession/messages/
  // permissions are a single global store, and the native stack keeps screens
  // underneath a pushed one mounted. Without re-selecting on focus, navigating
  // to another session and back would leave this screen bound to the *other*
  // session's data (and its permission/question prompts) — so a user could
  // approve the wrong session's tool call. useFocusEffect re-binds this screen
  // to its own session whenever it becomes visible again.
  useFocusEffect(
    useCallback(() => {
      if (!id) return
      selectSession(id, directory).then(() => {
        // Re-fetch pending permissions/questions from the server to recover from
        // missed SSE events or failed optimistic removals
        const connState = useConnections.getState()
        const c = directory ? (connState.clientForDirectory(directory) ?? connState.client) : connState.client
        if (c) refreshPending(c, id)
      })
    }, [id, directory]),
  )

  // Sync model chip from latest assistant message
  useEffect(() => {
    if (isCodex || !messages || messages.length === 0) return
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "assistant" && msg.providerID && msg.modelID) {
        setModel({ providerID: msg.providerID, modelID: msg.modelID })
        return
      }
      if (msg.role === "user" && msg.model) {
        setModel(msg.model)
        return
      }
    }
  }, [currentSession?.id, messages?.length, isCodex])

  // Slash command handler
  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.type === "builtin") {
        if (isCodex && CODEX_COMMANDS.some(command => command.trigger === cmd.trigger)) {
          setInput("")
          if (cmd.trigger === "compact") {
            openCodex("status")
            if (sessionClient && currentSession) void sessionClient.codex.compact(currentSession.id)
              .then(updateCodexSession).catch(error => Alert.alert("Codex", codexError(error)))
          } else openCodex(cmd.trigger === "effort" ? "effort" : cmd.trigger === "permissions" ? "permissions" : cmd.trigger === "plan" ? "mode" : "status")
          return
        }
        switch (cmd.trigger) {
          case "new":
            if (!isCodex) { router.back(); return }
            setInput("")
            void useSessions.getState().createSession().then(session => {
              if (session) router.replace({ pathname: "/session/[id]", params: { id: session.id, directory: session.directory } })
            }).catch(error => Alert.alert("Session", codexError(error)))
            return
          case "model":
            setInput("")
            modelSheetRef.current?.expand()
            return
          case "agent":
            setInput("")
            cycleAgent()
            return
        }
      }
      setInput(`/${cmd.trigger} `)
    },
    [router, cycleAgent, isCodex, openCodex, sessionClient, currentSession, updateCodexSession],
  )

  // --- Image picking ---

  // Convert any image (including HEIC/HEIF from iOS) to guaranteed JPEG bytes
  const MAX_DIMENSION = 1568 // Anthropic recommended max
  async function toJpeg(uri: string, width: number, height: number): Promise<Attachment> {
    const actions: ImageManipulator.Action[] = []
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / Math.max(width, height)
      actions.push({ resize: { width: Math.round(width * scale), height: Math.round(height * scale) } })
    }
    const result = await ImageManipulator.manipulateAsync(uri, actions, {
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.8,
      base64: true,
    })
    return {
      uri: result.uri,
      mime: "image/jpeg",
      filename: "image.jpg",
      width: result.width,
      height: result.height,
      base64: result.base64 || undefined,
    }
  }

  const pickFromLibrary = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 1, // full quality - we compress in manipulator
    })
    if (result.canceled) return
    const settled = await Promise.allSettled(result.assets.map((a) => toJpeg(a.uri, a.width, a.height)))
    const items = settled.filter((r) => r.status === "fulfilled").map((r) => r.value)
    if (items.length) setAttachments((prev) => [...prev, ...items])
    if (settled.some((r) => r.status === "rejected")) {
      console.error(
        "Failed to process image(s):",
        settled.filter((r) => r.status === "rejected").map((r) => r.reason),
      )
      Alert.alert(t("session.alerts.imageFailedTitle"), t("session.alerts.imageFailedMessage"))
    }
  }, [t])

  const pickFromCamera = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(t("session.alerts.cameraPermissionTitle"), t("session.alerts.cameraPermissionMessage"))
      return
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 1 })
    if (result.canceled) return
    const a = result.assets[0]
    try {
      const item = await toJpeg(a.uri, a.width, a.height)
      setAttachments((prev) => [...prev, item])
    } catch (err) {
      console.error("Failed to process photo:", err)
      Alert.alert(t("session.alerts.imageFailedTitle"), t("session.alerts.imageFailedMessage"))
    }
  }, [t])

  const pasteFromClipboard = useCallback(async () => {
    // Try image first
    const hasImage = await Clipboard.hasImageAsync()
    if (hasImage) {
      const img = await Clipboard.getImageAsync({ format: "png" })
      if (img?.data) {
        const uri = img.data.startsWith("data:") ? img.data : `data:image/png;base64,${img.data}`
        const item = await toJpeg(uri, img.size.width, img.size.height)
        setAttachments((prev) => [...prev, item])
        return
      }
    }
    // Fall back to text
    const hasText = await Clipboard.hasStringAsync()
    if (hasText) {
      const text = await Clipboard.getStringAsync()
      if (text) {
        setInput((prev) => prev + text)
        return
      }
    }
    Alert.alert(t("session.alerts.emptyClipboardTitle"), t("session.alerts.emptyClipboardMessage"))
  }, [t])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // --- Send ---
  const handleSend = async () => {
    if (revertingRef.current || forkingRef.current || (!input.trim() && attachments.length === 0)) return
    const builtin = attachments.length === 0 && isCodex ? allCommands.find(command => command.type === "builtin" && input.trim() === `/${command.trigger}`) : undefined
    if (builtin) { handleSlashSelect(builtin); return }
    const authenticated = await authenticateForMessage()
    if (!authenticated) {
      Alert.alert(t("session.alerts.authRequiredTitle"), t("session.alerts.authRequiredMessage"))
      return
    }

    const text = input.trim()
    const files = [...attachments]
    setInput("")
    setAttachments([])

    // Server slash commands (no attachments for commands)
    if (text.startsWith("/") && files.length === 0) {
      const [cmdName, ...args] = text.split(" ")
      const name = cmdName.slice(1)
      const match = serverCommands.find((c) => c.name === name)
      if (match && sessionClient && currentSession) {
        sessionClient.session
          .command(currentSession.id, {
            command: name,
            arguments: args.join(" "),
            agent,
            model: model ? `${model.providerID}/${model.modelID}` : undefined,
          })
          .catch((err) => console.error("Command failed:", err))
        return
      }
    }

    // Messages are queued server-side when the session is busy.
    // No need to abort - just send and it will be processed after current response.
    try {
      await sendMessage(text, isCodex ? undefined : model || undefined, isCodex ? undefined : agent || undefined, files, isCodex ? undefined : variant || undefined)
    } catch (err) {
      console.error("Send failed:", err)
      // Restore the user's text and attachments so their input isn't lost.
      setInput((prev) => (prev ? prev : text))
      setAttachments((prev) => (prev.length ? prev : files))
      Alert.alert(t("session.alerts.sendFailedTitle"), t("session.alerts.sendFailedMessage"))
    }
  }

  // In inverted mode, offset 0 = bottom. Show scroll button when scrolled away from bottom.
  const handleScroll = useCallback((event: any) => {
    const { contentOffset } = event.nativeEvent
    setShowScrollButton(contentOffset.y > 200)
  }, [])

  // Debounce: onEndReached can fire multiple times during a single scroll gesture
  const loadingTriggered = useRef(false)
  const handleLoadMore = useCallback(() => {
    if (hasMore && !loadingMore && !loadingTriggered.current) {
      loadingTriggered.current = true
      loadOlderMessages()
    }
  }, [hasMore, loadingMore, loadOlderMessages])

  // Reset trigger when loading finishes
  useEffect(() => {
    if (!loadingMore) loadingTriggered.current = false
  }, [loadingMore])

  // Detect reconnecting → stable transition for the "Connected ✓" flash.
  // reconnectAttempts and lastDisconnectAt reset in the same set() call, so we
  // can't use lastDisconnectAt alone; a useRef tracks the prior reconnecting state.
  useEffect(() => {
    const isReconnecting = reconnectAttempts > 0
    if (prevReconnecting.current && !isReconnecting) {
      setShowConnectedFlash(true)
      const t = setTimeout(() => setShowConnectedFlash(false), 2000)
      return () => clearTimeout(t)
    }
    prevReconnecting.current = isReconnecting
  }, [reconnectAttempts])

  const handlePermissionReply = async (requestID: string, reply: "once" | "always" | "reject") => {
    if (!sessionClient || !sessionID) return
    // Snapshot for rollback
    const snapshot = useEvents.getState().permissions[sessionID] || []
    // Optimistically remove from UI
    useEvents.setState((state) => ({
      permissions: {
        ...state.permissions,
        [sessionID]: snapshot.filter((p) => p.id !== requestID),
      },
    }))
    try {
      await sessionClient.permission.reply(requestID, reply)
    } catch (err) {
      console.error("Permission reply failed:", err)
      // Restore the prompt so the user can retry
      useEvents.setState((state) => ({
        permissions: { ...state.permissions, [sessionID]: snapshot },
      }))
      Alert.alert(t("session.alerts.replyFailedTitle"), t("session.alerts.replyFailedMessage"))
    }
  }

  const handleQuestionReply = async (requestID: string, answers: string[][]) => {
    if (!sessionClient || !sessionID) return
    const snapshot = useEvents.getState().questions[sessionID] || []
    useEvents.setState((state) => ({
      questions: {
        ...state.questions,
        [sessionID]: snapshot.filter((q) => q.id !== requestID),
      },
    }))
    try {
      await sessionClient.question.reply(requestID, answers)
    } catch (err) {
      console.error("Question reply failed:", err)
      useEvents.setState((state) => ({
        questions: { ...state.questions, [sessionID]: snapshot },
      }))
      Alert.alert(t("session.alerts.replyFailedTitle"), t("session.alerts.replyFailedMessage"))
    }
  }

  const handleQuestionReject = async (requestID: string) => {
    if (!sessionClient || !sessionID) return
    const snapshot = useEvents.getState().questions[sessionID] || []
    useEvents.setState((state) => ({
      questions: {
        ...state.questions,
        [sessionID]: snapshot.filter((q) => q.id !== requestID),
      },
    }))
    try {
      await sessionClient.question.reject(requestID)
    } catch (err) {
      console.error("Question reject failed:", err)
      useEvents.setState((state) => ({
        questions: { ...state.questions, [sessionID]: snapshot },
      }))
      Alert.alert(t("session.alerts.rejectFailedTitle"), t("session.alerts.rejectFailedMessage"))
    }
  }

  const handleModelSelect = useCallback(
    (providerID: string, modelID: string) => {
      if (isCodex && sessionClient && currentSession) {
        void sessionClient.codex.update(currentSession.id, { model: modelID }).then(updateCodexSession)
          .catch(error => Alert.alert("Codex", codexError(error)))
      } else setModel({ providerID, modelID })
    },
    [setModel, isCodex, sessionClient, currentSession, updateCodexSession],
  )

  // Current agent display
  const currentAgent = agents.find((a) => a.name === agent)
  const agentColor = currentAgent?.color || "#8b5cf6"
  const modelLabel = isCodex ? currentSession?.codex?.model || "Codex" : model?.modelID ? model.modelID.split("/").pop() || model.modelID : "default"

  // Variants for current model (for reasoning effort picker)
  const currentModelVariants = useMemo(() => {
    if (!model) return undefined
    const provider = providers.find((p) => p.id === model.providerID)
    const found = provider?.models.find((m) => m.id === model.modelID)
    return found?.variants
  }, [model, providers])

  return (
    <>
      <Stack.Screen
        options={{
          title: currentSession?.title || t("session.titleFallback"),
          headerRight: () => (
            <View style={s.headerRight}>
              {isCodex && <TouchableOpacity testID="codex-search-button" onPress={() => { Keyboard.dismiss(); setShowSearch(true) }} hitSlop={8}><Ionicons name="search-outline" size={20} color={isDark ? "#aaaaaa" : "#666666"} /></TouchableOpacity>}
              {isCodex && <TouchableOpacity testID="codex-files-button" onPress={() => { Keyboard.dismiss(); setShowFiles(true) }} hitSlop={8}><Ionicons name="git-compare-outline" size={20} color={isDark ? "#aaaaaa" : "#666666"} /></TouchableOpacity>}
              {shortDir && (
                <View style={[s.dirBadge, isDark && s.dirBadgeDark]}>
                  <Ionicons name="folder-outline" size={14} color={isDark ? "#888888" : "#666666"} />
                  <Text style={[s.dirText, isDark && s.dirTextDark]}>{shortDir}</Text>
                </View>
              )}
              <TouchableOpacity testID="codex-controls-button" onPress={() => isCodex ? openCodex("status") : setShowInfo((v) => !v)} hitSlop={8}>
                <Ionicons
                  name={showInfo ? "stats-chart" : "stats-chart-outline"}
                  size={20}
                  color={showInfo ? "#3b82f6" : isDark ? "#888888" : "#666666"}
                />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      <View
        ref={keyboardContainerRef}
        collapsable={false}
        style={s.container}
        onLayout={() => {
          // The Android root fills the edge-to-edge window. pageY includes
          // the native header without measureInWindow's status-bar subtraction.
          // Safe-area top can include a cutout and is not that subtraction.
          if (Platform.OS === "android") {
            keyboardContainerRef.current?.measure((_x, _y, _w, _h, _pageX, pageY) => setKeyboardOffset(pageY))
          } else {
            keyboardContainerRef.current?.measureInWindow((_x, y) => setKeyboardOffset(y))
          }
        }}
      >
        <KeyboardAvoidingView
          style={[s.container, isDark && s.containerDark]}
          // Edge-to-edge Android needs explicit keyboard avoidance. Keyboard
          // events use screen coordinates, but this view starts below the stack
          // header. Include its measured position in the window, or
          // the composer remains covered by that amount when Gboard opens.
          behavior="padding"
          // Android's hide event still carries window coordinates. Calculating
          // avoidance from them can leave padding after the IME is dismissed.
          enabled={Platform.OS !== "android" || keyboardVisible}
          keyboardVerticalOffset={keyboardOffset}
        >
          {/* Session info pulldown */}
          <SessionInfo
            session={currentSession}
            messages={messages || []}
            providers={providers}
            visible={showInfo}
            isDark={isDark}
            hasMore={hasMore}
            loadingAll={loadingMore}
            onLoadAll={() => {
              if (hasMore && !loadingMore) loadOlderMessages()
            }}
            onScrollToTop={() => {
              flatListRef.current?.scrollToEnd({ animated: true })
            }}
            onClose={() => setShowInfo(false)}
          />

          {/* SSE reconnect/connected banner */}
          {reconnectAttempts > 0 && (
            <View style={[s.banner, s.bannerReconnecting]}>
              <Text style={s.bannerText}>{t("session.banners.reconnecting", { attempt: reconnectAttempts })}</Text>
            </View>
          )}
          {showConnectedFlash && reconnectAttempts === 0 && (
            <View style={[s.banner, s.bannerConnected]}>
              <Text style={s.bannerText}>{t("session.banners.connected")}</Text>
            </View>
          )}

          {/* Pending revert (from "Edit message") — offer a way back before it's
              cleaned up by the next prompt. */}
          {revertMessageID && (
            <View style={[s.banner, s.bannerRevert]}>
              <Text style={s.bannerText}>{t("session.banners.reverted")}</Text>
              <TouchableOpacity
                onPress={() => {
                  unrevertSession()
                  // The composer was prefilled with the reverted message's text/
                  // attachments (see applyRevertResult) — clear it so Undo doesn't
                  // leave a stale draft that could be sent as a duplicate.
                  setInput("")
                  setAttachments([])
                }}
                hitSlop={8}
              >
                <Text style={s.bannerAction}>{t("session.banners.undo")}</Text>
              </TouchableOpacity>
            </View>
          )}

          {isLoading ? (
            <View style={s.loading}>
              <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
            </View>
          ) : (
            <View style={s.listWrap}>
              <FlatList
                ref={flatListRef}
                data={messageData}
                inverted
                keyExtractor={(item) => item.message.id}
                renderItem={({ item }) => (
                  <View testID={targetMessage === item.message.id ? "codex-search-target" : undefined} style={targetMessage === item.message.id ? { borderWidth: 2, borderColor: "#8b5cf6", borderRadius: 12 } : undefined}>
                  <MessageBubble
                    message={item.message}
                    parts={item.parts}
                    isDark={isDark}
                    onLongPress={handleMessageLongPress}
                    onFork={isCodex ? forkCodex : undefined}
                  />
                  </View>
                )}
                contentContainerStyle={s.messageList}
                onScrollToIndexFailed={({ index, averageItemLength }) => {
                  if (!targetMessage || jumpRetries.current++ > 12) return
                  flatListRef.current?.scrollToOffset({ offset: Math.max(0, averageItemLength * index), animated: false })
                  setTimeout(() => flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 300)
                }}
                onScroll={handleScroll}
                scrollEventThrottle={100}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.5}
                // Prevent jump when older messages are prepended
                maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                ListFooterComponent={
                  loadingMore ? (
                    <View style={s.loadingMore}>
                      <ActivityIndicator size="small" color={isDark ? "#888888" : "#666666"} />
                      <Text style={[s.loadingMoreText, isDark && s.metaDark]}>{t("session.loadingOlder")}</Text>
                    </View>
                  ) : null
                }
              />
              {/* Empty state rendered OUTSIDE the inverted list to avoid the
                  inverted transform mirroring its text/icon (see #ui-mirror). */}
              {messageData.length === 0 && (
                <View style={s.emptyOverlay} pointerEvents="none">
                  <Ionicons name="chatbubble-outline" size={48} color={isDark ? "#444444" : "#cccccc"} />
                  <Text style={[s.emptyText, isDark && s.metaDark]}>{t("session.empty.title")}</Text>
                  <Text style={[s.emptyHint, isDark && s.metaDark]}>{t("session.empty.hint")}</Text>
                </View>
              )}
              {showScrollButton && (
                <TouchableOpacity style={[s.scrollBtn, isDark && s.scrollBtnDark]} onPress={() => scrollToBottom(true)}>
                  <Ionicons name="chevron-down" size={24} color={isDark ? "#ffffff" : "#0a0a0a"} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {forkingCodex && <View style={s.banner}><ActivityIndicator color="#8b5cf6" /><Text style={{ color: "#8b5cf6" }}>{zh ? "正在创建分支…" : "Creating fork…"}</Text></View>}
          {revertingCodex && <View style={s.banner}><ActivityIndicator color="#8b5cf6" /><Text style={{ color: "#8b5cf6" }}>{zh ? "正在保存备份并回退…" : "Saving backup and rewinding…"}</Text></View>}
          {/* Status */}
          {currentSession && <StatusIndicator sessionID={currentSession.id} isDark={isDark} />}

          {/* Permissions */}
          {permissions.map((perm) => (
            <PermissionPrompt
              key={perm.id}
              permission={perm}
              isDark={isDark}
              onReply={(reply) => handlePermissionReply(perm.id, reply)}
            />
          ))}

          {/* Questions */}
          {questions.map((q) => (
            <QuestionPrompt
              key={q.id}
              request={q}
              isDark={isDark}
              onReply={(answers) => handleQuestionReply(q.id, answers)}
              onReject={() => handleQuestionReject(q.id)}
            />
          ))}

          {/* Slash popover */}
          {slashActive && (
            <SlashPopover query={slashQuery} commands={allCommands} isDark={isDark} onSelect={handleSlashSelect} />
          )}

          {/* Agent/model toolbar */}
          <View style={[s.toolbar, isDark && s.toolbarDark]}>
            <TouchableOpacity
              style={[s.agentChip, { borderColor: agentColor }]}
              onPress={() => isCodex ? openCodex("mode") : cycleAgent()}
              onLongPress={() => isCodex ? openCodex("mode") : cycleAgent(-1)}
            >
              <View style={[s.agentDot, { backgroundColor: agentColor }]} />
              <Text style={[s.agentLabel, isDark && s.textWhite]}>{isCodex ? currentSession?.codex?.mode || "default" : agent || "build"}</Text>
              <Ionicons name="swap-horizontal-outline" size={12} color={isDark ? "#888888" : "#666666"} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.modelChip, isDark && s.modelChipDark]}
              onPress={() => modelSheetRef.current?.expand()}
              testID="model-chip"
            >
              <Ionicons name="hardware-chip-outline" size={14} color={isDark ? "#888888" : "#666666"} />
              <Text style={[s.modelLabel, isDark && s.metaDark]} numberOfLines={1}>
                {modelLabel}
              </Text>
            </TouchableOpacity>

            {isCodex && (
              <TouchableOpacity style={[s.variantChip, isDark && s.variantChipDark]} onPress={() => openCodex("effort")} testID="codex-effort-chip">
                <Ionicons name="flash-outline" size={14} color="#8b5cf6" />
                <Text style={[s.variantLabel, isDark && s.metaDark]}>{currentSession?.codex?.effort || "default"}</Text>
              </TouchableOpacity>
            )}
            {!isCodex && currentModelVariants && Object.keys(currentModelVariants).length > 0 && (
              <TouchableOpacity
                style={[s.variantChip, isDark && s.variantChipDark, variant && s.variantChipActive]}
                onPress={() => variantSheetRef.current?.expand()}
                testID="variant-chip"
              >
                <Ionicons name="flash-outline" size={14} color={variant ? "#8b5cf6" : isDark ? "#888888" : "#666666"} />
                <Text style={[s.variantLabel, isDark && s.metaDark, variant && s.variantLabelActive]} numberOfLines={1}>
                  {variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : t("session.toolbar.auto")}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Attachment preview */}
          <ImageAttachments attachments={attachments} isDark={isDark} onRemove={removeAttachment} />

          {/* Input */}
          <View
            style={[s.inputContainer, isDark && s.inputContainerDark, { paddingBottom: Math.max(12, insets.bottom) }]}
          >
            <View style={s.inputRow}>
              {/* Attach button */}
              <TouchableOpacity style={s.attachBtn} onPress={pickFromLibrary} onLongPress={pickFromCamera}>
                <Ionicons name="add-circle-outline" size={26} color={isDark ? "#888888" : "#666666"} />
              </TouchableOpacity>

              {/* Clipboard paste button */}
              <TouchableOpacity style={s.attachBtn} onPress={pasteFromClipboard}>
                <Ionicons name="clipboard-outline" size={22} color={isDark ? "#888888" : "#666666"} />
              </TouchableOpacity>

              <TextInput
                style={[s.input, isDark && s.inputDark, speech.listening && s.inputListening]}
                placeholder={
                  speech.listening
                    ? t("session.input.placeholderListening")
                    : isSending
                      ? t("session.input.placeholderFollowUp")
                      : t("session.input.placeholderDefault")
                }
                placeholderTextColor={speech.listening ? "#ef4444" : isDark ? "#666666" : "#999999"}
                value={speech.listening ? speech.transcript : input}
                onChangeText={speech.listening ? undefined : setInput}
                editable={!speech.listening}
                multiline
                maxLength={10000}
                testID="chat-message-input"
              />
              {/* Stop button: only when busy and no input */}
              {isSending && !input.trim() && attachments.length === 0 && !speech.listening && (
                <TouchableOpacity style={s.stopBtn} onPress={abortSession}>
                  <Ionicons name="stop" size={20} color="#ffffff" />
                </TouchableOpacity>
              )}
              {/* Mic button: when no input, not sending, and not listening */}
              {!isSending && !input.trim() && attachments.length === 0 && !speech.listening && (
                <TouchableOpacity style={s.micBtn} onPress={speech.start}>
                  <Ionicons name="mic" size={22} color={isDark ? "#888888" : "#666666"} />
                </TouchableOpacity>
              )}
              {/* Listening indicator: tap to stop */}
              {speech.listening && (
                <TouchableOpacity style={s.micBtnActive} onPress={speech.stop}>
                  <Ionicons name="mic" size={22} color="#ffffff" />
                </TouchableOpacity>
              )}
              {/* Send button: when there's input */}
              {!speech.listening && (input.trim() || attachments.length > 0) && (
                <TouchableOpacity style={s.sendBtn} onPress={handleSend} testID="chat-send-button">
                  <Ionicons name="send" size={20} color="#ffffff" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>

      {isCodex && <CodexSearch visible={showSearch} client={sessionClient} sessionId={currentSession?.id} isDark={isDark} onClose={() => setShowSearch(false)} onSelect={locateMessage} />}
      {isCodex && <CodexFiles visible={showFiles} client={sessionClient} sessionId={currentSession?.id} isDark={isDark} onClose={() => setShowFiles(false)} />}
      {isCodex && <CodexControls visible={showCodex} tab={codexTab} session={currentSession} client={sessionClient}
        isDark={isDark} busy={isSending} onClose={() => setShowCodex(false)} onSession={updateCodexSession} onFork={() => forkCodex()} forking={forkingCodex} />}

      {/* Model picker bottom sheet */}
      <ModelPicker
        sheetRef={modelSheetRef}
        providers={providers}
        selected={isCodex && currentSession?.codex?.model ? { providerID: "codex", modelID: currentSession.codex.model } : model}
        isDark={isDark}
        onSelect={handleModelSelect}
      />

      {/* Reasoning effort (variant) picker bottom sheet */}
      <VariantPicker
        sheetRef={variantSheetRef}
        variants={currentModelVariants}
        selected={variant}
        isDark={isDark}
        onSelect={setVariant}
      />
    </>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  containerDark: { backgroundColor: "#0a0a0a" },
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
  listWrap: { flex: 1, position: "relative" },

  // Messages
  messageList: { padding: 16, paddingBottom: 8 },

  // Scroll button
  scrollBtn: {
    position: "absolute",
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  scrollBtnDark: { backgroundColor: "#2a2a2a" },

  // Loading more (appears at top in inverted list = ListFooterComponent)
  loadingMore: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
  },
  loadingMoreText: { fontSize: 13, color: "#999999" },

  // Empty state overlay — sits on top of the (empty) inverted list, untransformed,
  // so its text/icon render upright and un-mirrored on Android.
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
  },

  // Empty
  empty: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 64 },
  emptyText: { fontSize: 16, color: "#999999", marginTop: 12 },
  emptyHint: { fontSize: 13, color: "#bbbbbb", marginTop: 4 },
  metaDark: { color: "#666666" },
  textWhite: { color: "#ffffff" },

  // Toolbar
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    backgroundColor: "#ffffff",
  },
  toolbarDark: { borderTopColor: "#1a1a1a", backgroundColor: "#0a0a0a" },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  agentDot: { width: 8, height: 8, borderRadius: 4 },
  agentLabel: { fontSize: 12, fontWeight: "600", color: "#0a0a0a" },
  modelChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  modelChipDark: { backgroundColor: "#1a1a1a" },
  modelLabel: { fontSize: 12, color: "#666666", maxWidth: 160 },

  // Variant (reasoning effort) chip
  variantChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  variantChipDark: { backgroundColor: "#1a1a1a" },
  variantChipActive: { backgroundColor: "#f5f3ff" },
  variantLabel: { fontSize: 12, color: "#666666" },
  variantLabelActive: { color: "#8b5cf6" },

  // Input
  inputContainer: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    backgroundColor: "#ffffff",
  },
  inputContainerDark: { borderTopColor: "#1a1a1a", backgroundColor: "#0a0a0a" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  attachBtn: {
    width: 36,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  input: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 120,
    color: "#0a0a0a",
  },
  inputDark: { backgroundColor: "#1a1a1a", color: "#ffffff" },
  inputListening: { borderWidth: 1, borderColor: "#ef4444" },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#0a0a0a",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendBtnDisabled: { backgroundColor: "#cccccc" },
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  micBtnActive: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  stopBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },

  // Header
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  dirBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f5f5f5",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  dirBadgeDark: { backgroundColor: "#1a1a1a" },
  dirText: { fontSize: 12, color: "#666666", fontWeight: "500" },
  dirTextDark: { color: "#888888" },

  // SSE reconnect/connected banner
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: "center",
  },
  bannerReconnecting: { backgroundColor: "#92400e" },
  bannerConnected: { backgroundColor: "#065f46" },
  bannerText: { color: "#ffffff", fontSize: 13, fontWeight: "500" },

  // Pending revert (edit message) banner
  bannerRevert: {
    backgroundColor: "#1e3a8a",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  bannerAction: { color: "#93c5fd", fontSize: 13, fontWeight: "700" },
})
