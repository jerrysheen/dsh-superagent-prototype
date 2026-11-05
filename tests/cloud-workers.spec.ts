/** Cloud message authorization, durable deduplication and truthful communication receipts. */
import { expect, it, vi } from 'vitest'
import { CloudWorkers } from '../src/app/cloud-workers.ts'

const threadId = '6aeaf13e-ccac-83ec-85d6-c28959106f76'
const requestId = '6ae86870-a1dc-43ec-be4b-709d2aaaa6a3'
function fixture() {
  let value: unknown, available = true
  const store = { get: () => value, set: (_key: unknown, data: unknown) => { value = data } } as never
  const source = { reference: (uid: string) => { if (!available || uid !== 'chatgpt:' + threadId) throw new Error('not available'); return {} } } as never
  const send = vi.fn(async (_id: string, _prompt: string, id: string) => ({ receiptId: id }))
  const host = { store, source, transport: { send } }
  const workers = new CloudWorkers(host)
  const worker = workers.register({ threadId, name: '通用问答', purpose: 'qa', description: '不依赖项目的解释与问答' })
  return { workers, worker, send, host, unavailable: () => { available = false } }
}
it('registers a projectless Q&A worker and prepares idempotent drafts without sending', () => {
  const { workers, worker, send } = fixture()
  const draft = workers.prepare({ workerId: worker.id, requestId, question: '解释一个概念' })
  expect(workers.prepare({ workerId: worker.id, requestId, question: '解释一个概念' })).toEqual(draft)
  expect(draft).toMatchObject({ state: 'prepared', threadId, userVerified: false })
  expect(workers.view().workers[0]).toMatchObject({ provider: 'chatgpt', scope: 'cloud', purpose: 'qa', settings: 'inherit' })
  expect(send).not.toHaveBeenCalled()
  expect(() => workers.prepare({ workerId: worker.id, requestId, question: 'different' })).toThrow(/requestId/)
})
it('requires explicit confirmation and sends to the bound original thread exactly once', async () => {
  const { workers, worker, send, host } = fixture()
  workers.prepare({ workerId: worker.id, requestId, question: '解释一个概念' })
  await expect(workers.send(requestId, {})).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  expect(await workers.send(requestId, { confirmed: true })).toMatchObject({ state: 'submitted', receiptId: requestId, userVerified: false })
  await workers.send(requestId, { confirmed: true })
  await new CloudWorkers(host).send(requestId, { confirmed: true })
  expect(send).toHaveBeenCalledExactlyOnceWith(threadId, '解释一个概念', requestId)
})
it('retains an uncertain receipt on transport failure and blocks retransmission, including after restart', async () => {
  const { workers, worker, send, host } = fixture()
  send.mockRejectedValue(new Error('Timed out after submission'))
  workers.prepare({ workerId: worker.id, requestId, question: '问题' })
  expect(await workers.send(requestId, { confirmed: true })).toMatchObject({ state: 'uncertain' })
  await expect(new CloudWorkers(host).send(requestId, { confirmed: true })).rejects.toThrow(/不会自动重发/)
  expect(send).toHaveBeenCalledTimes(1)
})
it('rejects disabled or removed target sessions before sending and never substitutes another worker', async () => {
  const { workers, worker, send, unavailable } = fixture()
  workers.prepare({ workerId: worker.id, requestId, question: '问题' })
  workers.enable(worker.id, { enabled: false })
  await expect(workers.send(requestId, { confirmed: true })).rejects.toThrow(/停用/)
  workers.enable(worker.id, { enabled: true }); unavailable()
  await expect(workers.send(requestId, { confirmed: true })).rejects.toThrow(/目标不可用/)
  expect(send).not.toHaveBeenCalled()
})
it('serializes concurrent sends per thread and recovers a sending receipt as uncertain after a crash', async () => {
  const { workers, worker, send, host } = fixture()
  const pending = Promise.withResolvers<{ receiptId: string }>()
  send.mockReturnValue(pending.promise)
  workers.prepare({ workerId: worker.id, requestId, question: '问题' })
  const job = workers.send(requestId, { confirmed: true })
  await expect(workers.send(requestId, { confirmed: true })).rejects.toThrow(/发送中/)
  expect(new CloudWorkers(host).view().receipts[0]?.state).toBe('uncertain')
  pending.resolve({ receiptId: requestId }); await job
  expect(send).toHaveBeenCalledTimes(1)
})
it('records a user-provided answer as response-visible, never verified completion', async () => {
  const { workers, worker } = fixture()
  workers.prepare({ workerId: worker.id, requestId, question: '问题' })
  expect(() => workers.result(requestId, { confirmed: true, answer: '过早的回答' })).toThrow(/尚未提交/)
  await workers.send(requestId, { confirmed: true })
  expect(workers.result(requestId, { confirmed: true, answer: '用户回填的本次回答' })).toMatchObject({ state: 'response_visible', resultSource: 'user', userVerified: false })
})
it('exposes only discovery, draft preparation and receipt-reading tools; no autonomous send tool', () => {
  const { workers, send } = fixture()
  expect(workers.tools().map(tool => tool.name)).toEqual(['list_cloud_workers', 'prepare_cloud_question', 'get_cloud_question_receipt'])
  expect(send).not.toHaveBeenCalled()
  expect(() => workers.register({ threadId, name: 'bad', model: 'pro', thinking: 'xhigh' })).toThrow()
})
