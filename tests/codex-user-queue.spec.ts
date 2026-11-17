import { expect, it, vi } from 'vitest'
import { queueCodexUserMessage } from '../src/app/codex-user-queue.ts'
import type { CodexQuestion } from '../src/app/codex-relay.ts'

const question: CodexQuestion = {
  requestId: '01a1a0f6-353d-7581-b6dd-077563be0281',
  threadId: '01a1a0f6-353d-7581-b6dd-077563be0280',
  question: 'Reply MARKER', confirmed: true,
}
const imageQuestion = { ...question, images: ['01a1a0f6-353d-7581-b6dd-077563be0282'] }
function harness() {
  const initialize = vi.fn(async () => {}), close = vi.fn(async () => {})
  const request = vi.fn(async (_method: string, params: any) => ({
    queuedSubmission: { id: 'native-queue-id', clientUserMessageId: params.clientUserMessageId,
      input: params.input.map((part: any) => part.type === 'localImage' ? { type: 'image', url: 'data:image/png;base64,fixture' } : part) },
  }))
  const factory = vi.fn(() => ({ initialize, request, close }))
  return { factory, initialize, request, close }
}
it('submits plain text as native user input with a matching queue receipt and no caller-source impersonation', async () => {
  const h = harness()
  await expect(queueCodexUserMessage(question, [], h.factory)).resolves.toEqual({
    receiptId: 'native-queue-id', clientUserMessageId: question.requestId, transport: 'native_user_queue',
  })
  expect(h.request).toHaveBeenCalledExactlyOnceWith('thread/queue/add', {
    threadId: question.threadId, clientUserMessageId: question.requestId,
    input: [{ type: 'text', text: question.question, text_elements: [] }],
  })
  expect(h.initialize).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce()
})
it('uses the same native queue for scoped image attachments and accepts its decoded image echo', async () => {
  const h = harness(), path = 'C:\\fixture\\image.png'
  await expect(queueCodexUserMessage(imageQuestion, [path], h.factory)).resolves.toMatchObject({ transport: 'native_user_queue' })
  expect(h.request).toHaveBeenCalledExactlyOnceWith('thread/queue/add', {
    threadId: question.threadId, clientUserMessageId: question.requestId,
    input: [{ type: 'text', text: question.question, text_elements: [] }, { type: 'localImage', path }],
  })
})
it('rejects unresolved attachments before creating a connection or sending text', async () => {
  const h = harness()
  await expect(queueCodexUserMessage(imageQuestion, [], h.factory)).rejects.toThrow(/附件未完整解析.*未发送/)
  expect(h.factory).not.toHaveBeenCalled()
})
it.each(['identity', 'text', 'image'] as const)('rejects a mismatched %s receipt as unknown without resending', async mismatch => {
  const h = harness()
  h.request.mockResolvedValue({
    queuedSubmission: { id: 'native-queue-id',
      clientUserMessageId: mismatch === 'identity' ? 'another-request' : question.requestId,
      input: [
        { type: 'text', text: mismatch === 'text' ? 'a different message' : question.question, text_elements: [] },
        ...(mismatch === 'image' ? [] : [{ type: 'image', url: 'data:image/png;base64,fixture' }]),
      ],
    },
  })
  await expect(queueCodexUserMessage(imageQuestion, ['C:\\fixture\\image.png'], h.factory)).rejects.toThrow(/提交结果未知.*不会自动重发/)
  expect(h.request).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce()
})
it('retains an uncertain transport failure and never falls back to another sending route', async () => {
  const h = harness()
  h.request.mockRejectedValue(new Error('CODEX_RPC_RECEIPT_UNCERTAIN'))
  await expect(queueCodexUserMessage(question, [], h.factory)).rejects.toThrow(/CODEX_RPC_RECEIPT_UNCERTAIN.*不会自动重发/)
  expect(h.request).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce()
})
