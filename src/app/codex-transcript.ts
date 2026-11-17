/** User-requested, selected-thread text projection. No batch import, disk dump, model calls or writer ownership. */
import { z } from 'zod'
import { CodexReadClient } from './codex-local-client.ts'

export const TranscriptQuery = z.object({ threadId: z.string().uuid(), cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5), progress: z.literal('published').optional() }).strict()
export interface TranscriptMessage { id: string; clientId?: string; role: 'user' | 'assistant'; text: string; truncated: boolean; phase?: 'commentary' | 'final_answer'; images?: { src: string; alt: string }[] }
export interface TranscriptTurn { id: string; startedAt: number; status: string; messages: TranscriptMessage[] }
export interface CodexTranscript { threadId: string; turns: TranscriptTurn[]; nextCursor: string | null }
interface TranscriptReader { initialize(): Promise<void>; request(method: string, params: unknown): Promise<any>; close(): void }

export async function readCodexTranscript(input: unknown, createReader: () => TranscriptReader = () => new CodexReadClient(), options: { allItems?: boolean; itemLimit?: number; image?: (source: string) => string | undefined } = {}): Promise<CodexTranscript> {
  const query = TranscriptQuery.parse(input), reader = createReader()
  try {
    await reader.initialize()
    const page = await reader.request('thread/turns/list', { threadId: query.threadId, limit: query.limit,
      sortDirection: 'desc', itemsView: 'notLoaded', ...(query.cursor ? { cursor: query.cursor } : {}) })
    if (!Array.isArray(page.data)) throw new Error('Codex 会话分页格式错误。')
    const turns: TranscriptTurn[] = []
    let remaining = 240000
    for (const turn of page.data) {
      const messages: TranscriptMessage[] = [], seen = new Set<string>()
      let cursor: string | undefined, complete = false
      for (let i = 0; i < (options.allItems ? Infinity : 6); i++) {
        const items = await reader.request('thread/items/list', { threadId: query.threadId, turnId: turn.id, limit: options.itemLimit ?? 100,
          sortDirection: 'asc', ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(items.data)) throw new Error('Codex 会话消息格式错误。')
        for (const entry of items.data) {
          if (entry.turnId !== turn.id) throw new Error('Codex 返回了其他轮次的消息，已拒绝展示。')
          const item = entry.item
          if (!item || !['userMessage', 'agentMessage'].includes(item.type)) continue
          // Tool execution, reasoning, system prompts and hidden records are not conversation text.
          if (item.type === 'agentMessage' && item.phase && item.phase !== 'final_answer'
            && !(query.progress === 'published' && item.phase === 'commentary')) continue
          let text = item.type === 'userMessage'
            ? (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => String(part.text ?? '')).join('\n')
            : String(item.text ?? '')
          const images: { src: string; alt: string }[] = []
          if (options.image && item.type === 'userMessage') for (const part of item.content ?? []) {
            const source = part.type === 'localImage' ? part.path : part.type === 'image' ? part.url : undefined
            if (typeof source !== 'string') continue
            const src = options.image(source)
            if (src) images.push({ src, alt: '消息中的图片' })
          }
          const presentImage = options.image
          if (presentImage) text = text.replace(/!\[([^\]]*)\]\((<[^>]+>|[^)]+)\)/g, (match: string, alt: string, url: string) => {
            const src = presentImage(String(url ?? '').replace(/^<|>$/g, '').trim())
            return src ? `![${alt}](${src})` : match
          })
          if (!text.trim() && !images.length) continue
          const limit = Math.min(40000, remaining)
          if (limit <= 0) throw new Error('当前页内容过多，请使用较小的分页数量。')
          messages.push({ id: String(item.id), ...(item.type === 'userMessage' && typeof item.clientId === 'string' ? { clientId: item.clientId } : {}),
            role: item.type === 'userMessage' ? 'user' : 'assistant',
            ...(query.progress === 'published' && item.type === 'agentMessage' ? { phase: item.phase === 'commentary' ? 'commentary' as const : 'final_answer' as const } : {}),
            text: text.slice(0, limit), truncated: text.length > limit, ...(images.length ? { images } : {}) })
          remaining -= Math.min(text.length, limit)
        }
        if (!items.nextCursor) { complete = true; break }
        if (seen.has(items.nextCursor)) throw new Error('Codex 消息分页游标重复。')
        cursor = items.nextCursor; seen.add(cursor!)
      }
      if (!complete) throw new Error('单轮消息过多，请在原 Codex 会话查看完整内容。')
      turns.push({ id: turn.id, status: String(turn.status), startedAt: typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : 0, messages })
    }
    return { threadId: query.threadId, turns: turns.reverse(), nextCursor: page.nextCursor ?? null }
  } finally { reader.close() }
}
