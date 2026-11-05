/** Only documented desktop deep links. User-click navigation; never sends messages or alters task states. */
import type { SessionCard } from '../app/session-hub.ts'

export interface NativeUiLink {
  id: string
  label: string
  href: string
  semantics: 'exact_existing_chat' | 'composer_draft'
  notice: string
}

const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WIN_LOCAL_DIRECTORY = /^[a-z]:\\[^?#\r\n]+$/i
const MAX_LINK_CHARS = 9500

/** Only a technical UUID or the exact documented Codex link can open an existing thread. */
export function codexNativeThreadId(input: string | null): string | null {
  if (!input) return null
  const value = input.trim()
  const id = value.startsWith('codex://threads/') ? value.slice('codex://threads/'.length) : value
  return CODEX_UUID.test(id) ? id.toLowerCase() : null
}
/** A project title or logical ID must never be interpreted as a filesystem path. */
export function nativeWindowsWorkspace(input: string | null | undefined): string | null {
  if (!input || !WIN_LOCAL_DIRECTORY.test(input) || input.includes('..')) return null
  return input
}
function coder(card: SessionCard): 'cursor' | 'codex' | null {
  const value = (card.provider + ' ' + card.surface).toLowerCase()
  if (value.includes('cursor')) return 'cursor'
  if (value.includes('codex')) return 'codex'
  return null
}
function safeDraft(protocol: 'cursor' | 'codex', prompt: string, workspace?: string | null): string | null {
  if (!prompt.trim()) return null
  const encoded = encodeURIComponent(prompt)
  if (protocol === 'cursor') {
    const result = 'cursor://anysphere.cursor-deeplink/prompt?text=' + encoded
    return result.length <= MAX_LINK_CHARS ? result : null
  }
  const path = nativeWindowsWorkspace(workspace)
  const result = 'codex://new?prompt=' + encoded + (path ? '&path=' + encodeURIComponent(path) : '')
  return result.length <= MAX_LINK_CHARS ? result : null
}
export function nativeSessionLinks(card: SessionCard): NativeUiLink[] {
  if (coder(card) !== 'codex') return []
  const id = codexNativeThreadId(card.threadId)
  if (!id || card.origin === 'test') return []
  return [{
    id: 'codex-existing', label: '在 Codex 打开原会话',
    href: 'codex://threads/' + id, semantics: 'exact_existing_chat',
    notice: '只打开已记录的技术线程 ID；不会发送消息或修改任务状态。',
  }]
}
export function nativeTaskLinks(card: SessionCard, instruction: string): NativeUiLink[] {
  if (card.origin === 'test') return []
  const type = coder(card)
  if (type === 'codex') {
    const existing = nativeSessionLinks(card)
    if (existing.length) return existing
    const href = safeDraft('codex', instruction, card.workspacePath)
    return href ? [{
      id: 'codex-draft', label: '在 Codex 新建任务草稿',
      href, semantics: 'composer_draft',
      notice: '打开新聊天并预填任务，不是恢复原会话；不会自动发送。目录未知时不传入 path。',
    }] : []
  }
  if (type === 'cursor') {
    const href = safeDraft('cursor', instruction)
    return href ? [{
      id: 'cursor-draft', label: '在 Cursor 预填任务',
      href, semantics: 'composer_draft',
      notice: '官方 Deeplink 只保证预填提示词，不保证定位到指定 IDE 原会话或工程，也不会自动发送。',
    }] : []
  }
  return []
}
