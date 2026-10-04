import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import type { ChatImageSource } from '../../lib/image-source'

function Viewer({ source, label, onClose }: { source: ChatImageSource; label: string; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [size, setSize] = useState({ width: 1, height: 1 })
  const scale = useSharedValue(1), saved = useSharedValue(1)
  const x = useSharedValue(0), y = useSharedValue(0), startX = useSharedValue(0), startY = useSharedValue(0)
  const reset = () => { scale.value = withTiming(1); x.value = withTiming(0); y.value = withTiming(0) }
  const pinch = Gesture.Pinch().onBegin(() => { saved.value = scale.value }).onUpdate(event => {
    scale.value = Math.max(1, Math.min(5, saved.value * event.scale))
    if (scale.value === 1) { x.value = 0; y.value = 0 }
  })
  const pan = Gesture.Pan().onBegin(() => { startX.value = x.value; startY.value = y.value }).onUpdate(event => {
    const maxX = size.width * (scale.value - 1) / 2, maxY = size.height * (scale.value - 1) / 2
    x.value = Math.max(-maxX, Math.min(maxX, startX.value + event.translationX))
    y.value = Math.max(-maxY, Math.min(maxY, startY.value + event.translationY))
  })
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    scale.value = withTiming(scale.value > 1 ? 1 : 2)
    x.value = withTiming(0); y.value = withTiming(0)
  })
  const transform = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }))
  return <Modal visible animationType="fade" onRequestClose={onClose}>
    <GestureHandlerRootView style={[s.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.toolbar}>
        <TouchableOpacity testID="chat-image-close" onPress={onClose} style={s.action}><Text style={s.actionText}>{zh ? '关闭' : 'Close'}</Text></TouchableOpacity>
        <Text numberOfLines={1} style={s.viewerTitle}>{label}</Text>
        <TouchableOpacity testID="chat-image-reset" onPress={reset} style={s.action}><Text style={s.actionText}>{zh ? '还原' : 'Reset'}</Text></TouchableOpacity>
        <TouchableOpacity testID="chat-image-zoom" accessibilityLabel={zh ? '放大图片' : 'Zoom in'} onPress={() => { scale.value = withTiming(Math.min(5, scale.value + 1)) }} style={s.action}><Text style={s.actionText}>＋</Text></TouchableOpacity>
      </View>
      <View style={s.viewport} onLayout={event => setSize(event.nativeEvent.layout)}>
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
          <Animated.View style={[s.canvas, transform]}>
            <Image testID="chat-image-fullscreen" source={source} resizeMode="contain" style={s.fullImage} />
          </Animated.View>
        </GestureDetector>
      </View>
      <Text style={s.hint}>{zh ? '双指缩放，拖动查看；双击放大或还原' : 'Pinch to zoom, drag to move; double-tap to zoom or reset'}</Text>
    </GestureHandlerRootView>
  </Modal>
}

export function MessageImage({ source, label = '' }: { source?: ChatImageSource; label?: string }) {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0), [visible, setVisible] = useState(false)
  const [width, setWidth] = useState(280), [ratio, setRatio] = useState(4 / 3)
  useEffect(() => { setLoading(true); setFailed(false) }, [source?.uri])
  const retry = () => { setFailed(false); setLoading(true); setAttempt(value => value + 1) }
  return <View style={s.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <TouchableOpacity testID="chat-image-preview" accessibilityRole="button" accessibilityLabel={label || (zh ? '打开图片' : 'Open image')}
      disabled={loading || failed || !source} onPress={() => setVisible(true)} style={[s.preview, { height: Math.max(120, Math.min(320, width / ratio)) }]}>
      {!!source && !failed && <Image key={attempt} testID={loading ? 'chat-image-loading' : 'chat-image-loaded'} source={source} resizeMode="contain" style={s.fullImage}
        onLoad={event => {
          const image = event.nativeEvent.source
          if (image.width > 0 && image.height > 0) setRatio(image.width / image.height)
          setLoading(false)
        }} onError={() => { setLoading(false); setFailed(true) }} />}
      {loading && !!source && !failed && <View style={s.overlay}><ActivityIndicator color="#8b5cf6" /><Text style={s.notice}>{zh ? '正在加载图片…' : 'Loading image…'}</Text></View>}
      {(failed || !source) && <View testID="chat-image-error" style={s.overlay}>
        <Text style={s.notice}>{zh ? '图片暂时无法读取，文件可能已移动或连接已断开。' : 'Image unavailable. The file may have moved or the connection was interrupted.'}</Text>
      </View>}
    </TouchableOpacity>
    {!!label && <Text numberOfLines={2} style={s.caption}>{label}</Text>}
    {(failed || !source) && <TouchableOpacity testID="chat-image-retry" style={s.retry} onPress={retry}><Text style={s.retryText}>{zh ? '重试加载图片' : 'Retry image'}</Text></TouchableOpacity>}
    {visible && source && <Viewer source={source} label={label} onClose={() => setVisible(false)} />}
  </View>
}

const s = StyleSheet.create({
  root: { width: '100%', marginBottom: 10 }, preview: { width: '100%', backgroundColor: '#e8e8ed', borderRadius: 10, overflow: 'hidden' },
  fullImage: { width: '100%', height: '100%' }, overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 10 },
  notice: { color: '#555555', fontSize: 13, textAlign: 'center' }, caption: { color: '#888888', fontSize: 12, marginTop: 6 },
  retry: { padding: 12, alignSelf: 'flex-start' }, retryText: { color: '#8b5cf6', fontWeight: '600' },
  viewer: { flex: 1, backgroundColor: '#111111' }, toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  action: { padding: 12 }, actionText: { color: '#c4b5fd', fontSize: 16 }, viewerTitle: { color: '#ffffff', flex: 1, fontSize: 13 },
  viewport: { flex: 1, overflow: 'hidden' }, canvas: { width: '100%', height: '100%' }, hint: { color: '#aaaaaa', textAlign: 'center', padding: 12, fontSize: 12 },
})
