import { expect, it, vi } from 'vitest'
import { continueDesktopCodex } from '../src/app/codex-desktop-relay.ts'
const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280'
const question = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0281', threadId, question: 'Reply MARKER', confirmed: true as const }

function harness(options: { mismatch?: boolean; failure?: boolean; timeout?: boolean; provisional?: boolean } = {}) {
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
        { turnId: 'new-turn', item: { type: 'userMessage', content: [{ type: 'text', text: options.mismatch ? 'Someone else asked this' : question.question }] } },
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
