import { useEffect, useRef, useState } from "react"
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput, View, type ScrollViewProps } from "react-native"

// Android edge-to-edge windows need explicit avoidance even with adjustResize.
// Use the same screen-coordinate offset and hide reset as the chat composer.
export function KeyboardForm(props: ScrollViewProps) {
  const container = useRef<View>(null)
  const scroll = useRef<ScrollView>(null)
  const [offset, setOffset] = useState(0)
  const [visible, setVisible] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true))
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  const reveal = () => {
    const input = TextInput.State.currentlyFocusedInput()
    if (visible && input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, offset + 16, true)
  }
  return (
    <View ref={container} collapsable={false} style={{ flex: 1 }} onLayout={() => {
      if (Platform.OS === "android") {
        container.current?.measure((_x, _y, _w, _h, _pageX, pageY) => setOffset(pageY))
      } else {
        container.current?.measureInWindow((_x, y) => setOffset(y))
      }
    }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding"
        enabled={Platform.OS !== "android" || visible} keyboardVerticalOffset={offset}>
        <ScrollView {...props} ref={scroll} onLayout={event => { props.onLayout?.(event); reveal() }} />
      </KeyboardAvoidingView>
    </View>
  )
}
