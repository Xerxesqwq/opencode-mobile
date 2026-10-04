import type { Message, Part } from './sdk'

export function hasMessageContent(message: Message, parts: Part[]): boolean {
  if (message.role === 'user' || message.error?.message) return true
  return parts.some(part =>
    ((part.type === 'text' || part.type === 'reasoning') && !!part.text?.trim()) ||
    part.type === 'tool' ||
    (part.type === 'file' && !!part.mime?.startsWith('image/') && !!part.url),
  )
}
