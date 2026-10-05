export interface ChatImageSource { uri: string; headers?: Record<string, string> }
export type ImageSourceResolver = (url: string) => ChatImageSource | undefined

// Only the gateway's relative media route receives credentials. External images
// and data URLs must never inherit a connection's Authorization header.
export function imageSource(baseUrl: string, headers: Record<string, string>, url: string): ChatImageSource | undefined {
  if (/^\/session\/[\w%.~-]+\/codex\/media\/[\w%.~-]+\/\d+$/.test(url)) {
    return { uri: baseUrl.replace(/\/+$/, '') + url, headers }
  }
  if (/^(https?:\/\/|data:image\/|file:\/\/)/i.test(url)) return { uri: url }
  return undefined
}
