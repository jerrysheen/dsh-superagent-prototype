import { expect, it, vi } from 'vitest'
import { CodexRelay, type CodexQuestion, type CodexQueued, type CodexReply } from '../src/app/codex-relay.ts'
const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280'
const input = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0281', threadId, question: 'Reply TEST', confirmed: true }
it('requires explicit confirmation and an allowlisted target before invoking Codex', () => {
  const run = vi.fn()
  expect(() => new CodexRelay([], run).ask(input)).toThrow(/不在当前可续聊目录/)
  expect(() => new CodexRelay([threadId], run).ask({ ...input, confirmed: false })).toThrow()
  expect(run).not.toHaveBeenCalled()
})
it('deduplicates a retry, refuses changed request content and serializes the same target', async () => {
  let finish!: (value: { threadId: string; turnId: string; status: 'completed'; text: string }) => void
  const run = vi.fn(() => new Promise<{ threadId: string; turnId: string; status: 'completed'; text: string }>(resolve => { finish = resolve }))
  const relay = new CodexRelay([threadId], run), first = relay.ask(input)
  expect(relay.status(input.requestId)).toEqual({ status: 'pending' })
  expect(relay.ask(input)).toBe(first)
  expect(() => relay.ask({ ...input, question: 'Different' })).toThrow(/requestId/)
  expect(() => relay.ask({ ...input, requestId: '01a1a0f6-353d-7581-b6dd-077563be0282' })).toThrow(/正在处理/)
  await Promise.resolve()
  finish({ threadId, turnId: 'turn-test', status: 'completed', text: 'TEST' })
  await expect(first).resolves.toMatchObject({ text: 'TEST' })
  expect(relay.status(input.requestId)).toMatchObject({ status: 'completed', reply: { text: 'TEST' } })
  expect(run).toHaveBeenCalledOnce()
})
it('does not automatically resend a failed or uncertain request', async () => {
  const run = vi.fn(async () => { throw new Error('timeout; outcome unknown') })
  const relay = new CodexRelay([threadId], run)
  await expect(relay.ask(input)).rejects.toThrow(/unknown/)
  await expect(relay.ask(input)).rejects.toThrow(/unknown/)
  expect(run).toHaveBeenCalledOnce()
})
it('allows an indexed closed conversation without a separate pilot allowlist, and revokes removed targets', async () => {
  let ids = [threadId]
  const run = vi.fn(async () => ({ threadId, turnId: 'new', status: 'completed' as const, text: 'reply' }))
  const relay = new CodexRelay(() => ids, run, 'desktop_app')
  expect(relay.capabilities()).toMatchObject({ enabled: true, transport: 'desktop_app' })
  await relay.ask(input); expect(run).toHaveBeenCalledOnce()
  ids = []; expect(relay.capabilities().enabled).toBe(false)
  expect(() => relay.ask({ ...input, requestId: '01a1a0f6-353d-7581-b6dd-077563be0282' })).toThrow(/目录/)
})
it('accepts an image-only question while retaining attachment identity for request deduplication', async () => {
  const run = vi.fn(async () => ({ threadId, turnId: 'image-turn', status: 'completed' as const, text: 'image reply' }))
  const relay = new CodexRelay([threadId], run)
  const imageOnly = { ...input, question: '', images: ['01a1a0f6-353d-7581-b6dd-077563be0283'] }
  await relay.ask(imageOnly); expect(run).toHaveBeenCalledWith(imageOnly, expect.any(Function))
  expect(() => relay.ask({ ...imageOnly, images: ['01a1a0f6-353d-7581-b6dd-077563be0284'] })).toThrow(/requestId/)
  expect(() => relay.ask({ ...input, question: '', images: [] })).toThrow()
})

it('exposes accepted delivery while waiting and preserves the receipt if reply observation becomes uncertain', async () => {
  let reject!: (reason: Error) => void
  const delivery = { receiptId: 'native-queue-id', clientUserMessageId: input.requestId, transport: 'native_user_queue' as const }
  const run = vi.fn((_question: CodexQuestion, onQueued?: CodexQueued) => {
    onQueued?.(delivery)
    return new Promise<CodexReply>((_resolve, fail) => { reject = fail })
  })
  const relay = new CodexRelay([threadId], run, 'native_user_queue'), result = relay.ask(input)
  await Promise.resolve()
  expect(relay.capabilities().transport).toBe('native_user_queue')
  expect(relay.status(input.requestId)).toEqual({ status: 'pending', delivery })
  reject(new Error('No matching completed turn observed'))
  await expect(result).rejects.toThrow(/No matching/)
  expect(relay.status(input.requestId)).toMatchObject({ status: 'uncertain', delivery, error: 'No matching completed turn observed' })
  expect(relay.ask(input)).toBe(result)
  expect(run).toHaveBeenCalledOnce()
})
