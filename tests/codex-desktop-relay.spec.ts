import { expect, it, vi } from 'vitest'
import { continueDesktopCodex } from '../src/app/codex-desktop-relay.ts'
import { CodexRelay } from '../src/app/codex-relay.ts'
const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280'
const question = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0281', threadId, question: 'Reply MARKER', confirmed: true as const }

function harness(options: { mismatch?: boolean; failure?: boolean; timeout?: boolean; provisional?: boolean; clientId?: string | null; content?: { type: string; text?: string }[] } = {}) {
  let clock = 10000, lists = 0
  const request = vi.fn(async (method: string, params: any) => {
    if (method === 'thread/turns/list') {
      if (options.failure) throw new Error('read pagination unsupported')
      const iteration = lists++
      return { data: iteration === 0 || options.timeout ? [{ id: 'old-turn', status: 'completed', items: [] }]
        : [{ id: 'new-turn', status: options.provisional && iteration === 1 ? 'interrupted' : 'completed', startedAt: 10, items: [] }, { id: 'old-turn', status: 'completed', items: [] }] }
    }
    if (method === 'thread/items/list') {
      expect(params.turnId).toBe('new-turn')
      return { data: [
        { turnId: 'new-turn', item: { type: 'userMessage', ...(options.clientId !== undefined ? { clientId: options.clientId } : {}), content: options.content ?? [{ type: 'text', text: options.mismatch ? 'Someone else asked this' : question.question }] } },
        { turnId: 'new-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Working' } },
        { turnId: 'new-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'MARKER' } },
      ] }
    }
    throw new Error('No resume, turn/start or full history allowed')
  })
  const close = vi.fn(), queue = vi.fn(async () => 'queue-id')
  return { request, close, queue, deps: { reader: () => ({ initialize: async () => {}, request, close }), queue,
    now: () => clock, wait: async () => { clock += 2000 }, timeoutMs: 5000 } }
}
it('queues once and returns the matching new final reply without resuming or reading old message content', async () => {
  const h = harness()
  await expect(continueDesktopCodex(question, h.deps)).resolves.toMatchObject({ threadId, turnId: 'new-turn', text: 'MARKER', transport: 'desktop_queue', queueId: 'queue-id' })
  expect(h.queue).toHaveBeenCalledExactlyOnceWith(threadId, question.question)
  expect(h.close).toHaveBeenCalledOnce()
  expect(h.request.mock.calls.every(([method, params]) => method !== 'thread/turns/list' || params.itemsView === 'notLoaded')).toBe(true)
})
it('keeps a desktop-owner acknowledgment separate from native queue IDs', async () => {
  const h = harness()
  const queue = vi.fn(async () => ({ receiptId: question.requestId, transport: 'desktop_app' as const }))
  const result = await continueDesktopCodex(question, { ...h.deps, queue })
  expect(result).toMatchObject({ receiptId: question.requestId, transport: 'desktop_app', text: 'MARKER' })
  expect(result.queueId).toBeUndefined()
})
it('checks reply-reading capability before sending and never falls back to full history', async () => {
  const h = harness({ failure: true })
  await expect(continueDesktopCodex(question, h.deps)).rejects.toThrow(/unsupported/)
  expect(h.queue).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalledOnce()
})
it('does not present another new question\'s reply as this request\'s answer', async () => {
  const h = harness({ mismatch: true })
  await expect(continueDesktopCodex(question, h.deps)).rejects.toThrow(/超时/)
  expect(h.queue).toHaveBeenCalledOnce()
})
it('reports queued-but-unconfirmed delivery after a timeout and never resends', async () => {
  const h = harness({ timeout: true })
  await expect(continueDesktopCodex(question, h.deps)).rejects.toThrow(/问题已经提交/)
  expect(h.queue).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce()
})
it('waits through a provisional interrupted snapshot from another writer process', async () => {
  const h = harness({ provisional: true })
  await expect(continueDesktopCodex(question, h.deps)).resolves.toMatchObject({ turnId: 'new-turn', text: 'MARKER' })
  expect(h.queue).toHaveBeenCalledOnce()
  expect(h.request.mock.calls.filter(([method]) => method === 'thread/turns/list')).toHaveLength(3)
  expect(h.request.mock.calls.filter(([method]) => method === 'thread/items/list')).toHaveLength(1)
})

it('uses the acknowledged native client ID to correlate a new turn independently of rendered text', async () => {
  const h = harness({ mismatch: true, clientId: question.requestId })
  const delivery = { receiptId: 'native-queue-id', clientUserMessageId: question.requestId, transport: 'native_user_queue' as const }
  const onQueued = vi.fn()
  await expect(continueDesktopCodex(question, { ...h.deps, queue: async () => delivery, onQueued }))
    .resolves.toMatchObject({ turnId: 'new-turn', text: 'MARKER', ...delivery })
  expect(onQueued).toHaveBeenCalledExactlyOnceWith(delivery)
})
it('does not claim another client ID even when its new user message contains identical text', async () => {
  const h = harness({ clientId: '01a1a0f6-353d-7581-b6dd-077563be0282' })
  await expect(continueDesktopCodex(question, { ...h.deps, queue: async () => ({
    receiptId: 'native-queue-id', clientUserMessageId: question.requestId, transport: 'native_user_queue',
  }) })).rejects.toThrow(/超时/)
})
it.each([undefined, null])('does not claim identical text when the native user message client ID is %s', async clientId => {
  const h = harness({ clientId })
  await expect(continueDesktopCodex(question, { ...h.deps, queue: async () => ({
    receiptId: 'native-queue-id', clientUserMessageId: question.requestId, transport: 'native_user_queue',
  }) })).rejects.toThrow(/尚未确认原会话已处理/)
})
it.each([undefined, null])('keeps an image-only request uncertain when another new image turn has client ID %s', async clientId => {
  const h = harness({ clientId, content: [{ type: 'image' }] })
  const input = { ...question, question: '', images: ['01a1a0f6-353d-7581-b6dd-077563be0283'] }
  const delivery = { receiptId: 'native-queue-id', clientUserMessageId: input.requestId, transport: 'native_user_queue' as const }
  const queue = vi.fn(async () => delivery)
  const relay = new CodexRelay([threadId], (message, onQueued) => continueDesktopCodex(message, { ...h.deps, queue, onQueued }), 'native_user_queue')
  const result = relay.ask(input)
  await expect(result).rejects.toThrow(/尚未确认原会话已处理/)
  expect(relay.status(input.requestId)).toMatchObject({ status: 'uncertain', delivery })
  expect(relay.ask(input)).toBe(result)
  expect(queue).toHaveBeenCalledExactlyOnceWith(threadId, '')
  expect(h.close).toHaveBeenCalledOnce()
})
it('announces queue acceptance before a reply timeout without claiming the desktop writer consumed it', async () => {
  const h = harness({ timeout: true }), onQueued = vi.fn()
  await expect(continueDesktopCodex(question, { ...h.deps, onQueued })).rejects.toThrow(/尚未确认原会话已处理/)
  expect(onQueued).toHaveBeenCalledExactlyOnceWith({ queueId: 'queue-id', transport: 'desktop_queue' })
  expect(h.queue).toHaveBeenCalledOnce()
})
it('rejects images before opening the text-only CLI fallback so it cannot silently drop attachments', async () => {
  const reader = vi.fn()
  await expect(continueDesktopCodex({ ...question, images: ['01a1a0f6-353d-7581-b6dd-077563be0283'] }, { reader }))
    .rejects.toThrow(/不支持图片队列.*未发送/)
  expect(reader).not.toHaveBeenCalled()
})
