/** Send through Codex's native queue; read only the matching newly-created turn. Never resume the desktop writer. */
import { CodexReadClient, queueCodexMessage } from './codex-local-client.ts'
import type { CodexDelivery, CodexQuestion, CodexQueued, CodexReply } from './codex-relay.ts'

interface Turn { id: string; status: string; startedAt?: number | null }
interface Item { type: string; clientId?: string | null; text?: string; phase?: string | null; content?: { type: string; text?: string }[] }
interface Reader { initialize(): Promise<void>; request(method: string, params: unknown): Promise<any>; close(): void }
export interface DesktopRelayDependencies {
  reader: () => Reader
  queue: (threadId: string, text: string) => Promise<string | CodexDelivery>
  onQueued?: CodexQueued
  wait: () => Promise<void>
  now: () => number
  timeoutMs: number
}
const defaults: DesktopRelayDependencies = { reader: () => new CodexReadClient(), queue: queueCodexMessage,
  wait: () => new Promise(resolve => setTimeout(resolve, 1200)), now: Date.now, timeoutMs: 180000 }

async function listTurns(reader: Reader, threadId: string): Promise<Turn[]> {
  const result = await reader.request('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded' })
  if (!Array.isArray(result.data) || result.data.some((turn: any) => typeof turn.id !== 'string' || (turn.items?.length ?? 0) !== 0))
    throw new Error('Codex 未提供纯元数据轮次列表；未读取旧聊天，也不会降级读取全文。')
  return result.data
}

async function newTurnItems(reader: Reader, threadId: string, turnId: string): Promise<Item[]> {
  const items: Item[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 6; page++) {
    const result = await reader.request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(result.data)) throw new Error('Codex 新轮次内容格式错误。')
    for (const entry of result.data) {
      if (entry.turnId !== turnId) throw new Error('Codex 返回了其他轮次，已拒绝展示。')
      if (entry.item?.type === 'userMessage' || entry.item?.type === 'agentMessage') items.push(entry.item)
    }
    if (!result.nextCursor) return items
    if (seen.has(result.nextCursor)) throw new Error('Codex 新轮次分页重复。')
    cursor = result.nextCursor; seen.add(cursor!)
  }
  throw new Error('Codex 新轮次超过试点分页上限。')
}

export async function continueDesktopCodex(question: CodexQuestion, overrides: Partial<DesktopRelayDependencies> = {}): Promise<CodexReply> {
  // The legacy CLI fallback has no attachment input. Refuse before opening a connection or sending any text.
  if (question.images?.length && !overrides.queue) throw new Error('当前 Codex 连接不支持图片队列；消息未发送，请使用已连接的原生会话入口。')
  const deps = { ...defaults, ...overrides }, reader = deps.reader()
  let queued = false
  try {
    await reader.initialize()
    // Check the read capability before sending; this is a metadata snapshot, not historical messages.
    const baseline = new Set((await listTurns(reader, question.threadId)).map(turn => turn.id))
    const sentAt = deps.now(), receipt = await deps.queue(question.threadId, question.question)
    queued = true
    const delivery: CodexDelivery = typeof receipt === 'string' ? { queueId: receipt, transport: 'desktop_queue' } : receipt
    deps.onQueued?.(delivery)
    const ignored = new Set<string>()
    while (deps.now() - sentAt < deps.timeoutMs) {
      const turns = await listTurns(reader, question.threadId)
      for (const turn of turns) {
        if (baseline.has(turn.id) || ignored.has(turn.id)) continue
        if (typeof turn.startedAt === 'number' && turn.startedAt * 1000 < sentAt - 2000) continue
        // A reader in another process may see a provisional `interrupted` while
        // the desktop owner is still committing the turn. Only completed is proof.
        if (turn.status !== 'completed') continue
        const items = await newTurnItems(reader, question.threadId, turn.id)
        const sameQuestion = items.some(item => {
          if (item.type !== 'userMessage') return false
          // clientId is the protocol's user-message correlation field; it is not the queue or item ID.
          // Once the queue acknowledges a client ID, missing IDs are not evidence of a match.
          // Text compatibility is reserved for legacy transports that never supplied this correlation ID.
          if (delivery.clientUserMessageId !== undefined) return item.clientId === delivery.clientUserMessageId
          return item.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim() === question.question.trim()
            && (!question.images?.length || item.content?.some(part => part.type === 'image' || part.type === 'localImage'))
        })
        if (!sameQuestion) { ignored.add(turn.id); continue }
        const messages = items.filter(item => item.type === 'agentMessage')
        const finals = messages.filter(item => item.phase === 'final_answer')
        const text = (finals.length ? finals : messages).map(item => item.text ?? '').join('\n')
        if (!text.trim()) continue
        if (text.length > 64000) throw new Error('原会话回复超出试点展示上限，请打开原会话查看。')
        return { threadId: question.threadId, turnId: turn.id, status: 'completed', text, ...delivery }
      }
      await deps.wait()
    }
    throw new Error('问题已进入原 Codex 会话队列，但尚未确认原会话已处理或完成回复；等待回复超时。请打开原会话确认，不要重复发送。')
  } catch (error) {
    if (queued) throw new Error((error instanceof Error ? error.message : '读取回复失败。') + ' 问题已经提交，不会自动重发。')
    throw error
  } finally { reader.close() }
}
