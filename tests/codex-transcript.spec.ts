import { expect, it, vi } from 'vitest'
import { readCodexTranscript } from '../src/app/codex-transcript.ts'
const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280'
it('pages only the selected thread and projects user/assistant text in chronological order', async () => {
  const close = vi.fn(), request = vi.fn(async (method: string, params: any) => {
    expect(params.threadId).toBe(threadId)
    if (method === 'thread/turns/list') {
      expect(params.itemsView).toBe('notLoaded')
      return { data: [{ id: 'new', startedAt: 2, status: 'completed' }, { id: 'old', startedAt: 1, status: 'completed' }], nextCursor: 'older-page' }
    }
    expect(method).toBe('thread/items/list')
    return { data: [
      { turnId: params.turnId, item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'question' }] } },
      { turnId: params.turnId, item: { id: 'tool', type: 'commandExecution', output: 'DO_NOT_EXPOSE' } },
      { turnId: params.turnId, item: { id: 'reason', type: 'reasoning', text: 'DO_NOT_EXPOSE' } },
      { turnId: params.turnId, item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'reply' } },
    ] }
  })
  const result = await readCodexTranscript({ threadId, cursor: 'page', limit: 2 }, () => ({ initialize: async () => {}, request, close }))
  expect(result.nextCursor).toBe('older-page')
  expect(result.turns.map(turn => turn.id)).toEqual(['old', 'new'])
  expect(result.turns[0]?.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
  expect(close).toHaveBeenCalledOnce()
})
it('rejects other-turn records and closes the read-only connection', async () => {
  const close = vi.fn(), request = vi.fn(async (method: string) => method === 'thread/turns/list'
    ? { data: [{ id: 'selected-turn' }] } : { data: [{ turnId: 'wrong-turn', item: { id: 'x', type: 'agentMessage', text: 'wrong content' } }] })
  await expect(readCodexTranscript({ threadId }, () => ({ initialize: async () => {}, request, close }))).rejects.toThrow(/其他轮次/)
  expect(close).toHaveBeenCalledOnce()
})
it('makes clipping explicit and validates request bounds before opening Codex', async () => {
  const create = vi.fn()
  await expect(readCodexTranscript({ threadId, limit: 11 }, create)).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
  const result = await readCodexTranscript({ threadId }, () => ({ initialize: async () => {}, close: () => {},
    request: async (method: string) => method === 'thread/turns/list' ? { data: [{ id: 't', status: 'completed' }] }
      : { data: [{ turnId: 't', item: { type: 'agentMessage', id: 'a', text: 'a'.repeat(40001) } }] } }))
  expect(result.turns[0]?.messages[0]).toMatchObject({ truncated: true })
  expect(result.turns[0]?.messages[0]?.text).toHaveLength(40000)
})
it('lets full-catalog processing scan beyond six item pages while keeping hidden/tool content excluded', async () => {
  let pages = 0
  const result = await readCodexTranscript({ threadId, limit: 1 }, () => ({ initialize: async () => {}, close: () => {}, request: async (method: string) => {
    if (method === 'thread/turns/list') return { data: [{ id: 't', status: 'completed' }] }
    pages++
    return pages < 8 ? { data: [{ turnId: 't', item: { type: 'commandExecution', output: 'synthetic hidden output' } }], nextCursor: 'page-' + pages }
      : { data: [{ turnId: 't', item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'synthetic final reply' } }] }
  } }), { allItems: true })
  expect(pages).toBe(8)
  expect(result.turns[0]?.messages[0]?.text).toBe('synthetic final reply')
  expect(JSON.stringify(result)).not.toContain('hidden output')
})
it('projects image-only user attachments and rewrites local Markdown images through scoped capabilities', async () => {
  const image = vi.fn((source: string) => source.endsWith('.png') ? '/session-hub/api/codex/media?threadId=' + threadId + '&id=image' : undefined)
  const result = await readCodexTranscript({ threadId }, () => ({ initialize: async () => {}, close: () => {}, request: async (method: string) => method === 'thread/turns/list' ? { data: [{ id: 'turn', status: 'completed' }] }
    : { data: [{ turnId: 'turn', item: { type: 'userMessage', id: 'u', content: [{ type: 'localImage', path: 'C:\\Temp\\picture.png' }] } },
      { turnId: 'turn', item: { type: 'agentMessage', id: 'a', phase: 'final_answer', text: '![result](<F:/Project/image.png>)' } }] } }), { image })
  expect(result.turns[0]?.messages).toHaveLength(2)
  expect(result.turns[0]?.messages[0]?.images).toHaveLength(1)
  expect(result.turns[0]?.messages[1]?.text).toContain('/session-hub/api/codex/media?')
  expect(result.turns[0]?.messages[1]?.text).not.toContain('F:/Project')
})
