/** Registered cloud Q&A workers and durable message receipts, not a second task scheduler. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import type { ChatgptSource } from './chatgpt-source.ts'
import type { Tool } from './tools/tool.ts'

const Register = z.object({ threadId: z.string().uuid(), name: z.string().trim().min(1).max(100),
  purpose: z.enum(['qa', 'general']).default('qa'), description: z.string().trim().max(1000).default(''), enabled: z.boolean().default(true) }).strict()
const Question = z.object({ workerId: z.string().uuid(), requestId: z.string().uuid().optional(), question: z.string().trim().min(1).max(8000) }).strict()
export interface CloudWorker { id: string; threadId: string; name: string; purpose: 'qa' | 'general'; description: string; enabled: boolean }
export interface CloudMessageReceipt {
  id: string; workerId: string; threadId: string; workerName: string; question: string; createdAt: string; updatedAt: string
  state: 'prepared' | 'sending' | 'submitted' | 'uncertain' | 'response_visible' | 'cancelled'
  receiptId?: string; error?: string; answer?: string; resultSource?: 'user'; userVerified: false
}
type State = { workers: CloudWorker[]; receipts: CloudMessageReceipt[] }
const Key = record<State>('cloud-workers:v1')
export interface CloudMessageTransport { send(threadId: string, prompt: string, requestId: string): Promise<{ receiptId: string }> }

/** Registration grants selection only; every actual send requires an explicit panel confirmation. */
export class CloudWorkers {
  private pending = new Set<Promise<CloudMessageReceipt>>()
  constructor(private readonly host: { store: Pick<Store, 'get' | 'set'>; source: Pick<ChatgptSource, 'reference'>;
    transport?: CloudMessageTransport; closing?(): boolean }) {
    const state = this.state()
    if (state.receipts.some(item => item.state === 'sending')) this.save({ ...state, receipts: state.receipts.map(item => item.state === 'sending'
      ? { ...item, state: 'uncertain', error: '服务在发送期间中断，请在原会话核对；不会自动重发。' } : item) })
  }
  private state(): State { return this.host.store.get(Key) ?? { workers: [], receipts: [] } }
  private save(state: State) { this.host.store.set(Key, state) }
  private available(worker: CloudWorker) {
    if (!worker.enabled) return false
    try { this.host.source.reference('chatgpt:' + worker.threadId); return true } catch { return false }
  }
  view() {
    const state = this.state()
    return { connected: !!this.host.transport, workers: state.workers.map(worker => ({ ...worker, provider: 'chatgpt' as const,
      scope: 'cloud' as const, available: this.available(worker), settings: 'inherit' as const })), receipts: state.receipts }
  }
  register(input: unknown) {
    const value = Register.parse(input), state = this.state()
    this.host.source.reference('chatgpt:' + value.threadId)
    const prior = state.workers.find(item => item.threadId === value.threadId)
    if (!prior && state.workers.length >= 50) throw new Error('云端 Worker 已达到 50 个，请停用或整理已有配置。')
    const worker = { ...value, id: prior?.id ?? randomUUID() }
    this.save({ ...state, workers: [...state.workers.filter(item => item.id !== worker.id), worker] })
    return worker
  }
  enable(id: string, input: unknown) {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(input), state = this.state()
    if (!state.workers.some(item => item.id === id)) throw new Error('Worker 不存在。')
    this.save({ ...state, workers: state.workers.map(item => item.id === id ? { ...item, enabled } : item) })
    return this.view()
  }
  prepare(input: unknown): CloudMessageReceipt {
    const value = Question.parse(input), state = this.state(), worker = state.workers.find(item => item.id === value.workerId)
    if (!worker || !this.available(worker)) throw new Error('Worker 已停用或原会话不在启用目录中。')
    const id = value.requestId ?? randomUUID(), prior = state.receipts.find(item => item.id === id)
    if (prior) {
      if (prior.workerId !== worker.id || prior.question !== value.question) throw new Error('requestId 已用于其他问题。')
      return prior
    }
    if (state.receipts.length >= 500) throw new Error('云端消息回执已达到上限，请先整理记录。')
    const now = new Date().toISOString()
    const receipt: CloudMessageReceipt = { id, workerId: worker.id, threadId: worker.threadId, workerName: worker.name,
      question: value.question, createdAt: now, updatedAt: now, state: 'prepared', userVerified: false }
    this.save({ ...state, receipts: [...state.receipts, receipt] }); return receipt
  }
  private update(id: string, patch: Partial<CloudMessageReceipt>) {
    const state = this.state(), receipt = state.receipts.find(item => item.id === id)
    if (!receipt) throw new Error('消息回执不存在。')
    const updated = { ...receipt, ...patch, updatedAt: new Date().toISOString() }
    this.save({ ...state, receipts: state.receipts.map(item => item.id === id ? updated : item) }); return updated
  }
  send(id: string, input: unknown) {
    const job = this.sendOnce(id, input)
    this.pending.add(job)
    void job.then(() => this.pending.delete(job), () => this.pending.delete(job))
    return job
  }
  private async sendOnce(id: string, input: unknown) {
    z.object({ confirmed: z.literal(true) }).strict().parse(input)
    const state = this.state(), receipt = state.receipts.find(item => item.id === id)
    if (!receipt) throw new Error('消息回执不存在。')
    if (receipt.state === 'submitted' || receipt.state === 'response_visible') return receipt
    if (receipt.state !== 'prepared') throw new Error('此消息已发送中、已取消或结果不确定；请先在原会话核对，不会自动重发。')
    const worker = state.workers.find(item => item.id === receipt.workerId)
    if (!worker || worker.threadId !== receipt.threadId || !this.available(worker)) throw new Error('Worker 已停用或目标不可用；未发送。')
    if (!this.host.transport || this.host.closing?.()) throw new Error('云端发送连接器未就绪；未发送。')
    if (state.receipts.some(item => item.threadId === receipt.threadId && (item.state === 'sending' || item.state === 'uncertain')))
      throw new Error('该会话存在发送中或不确定的消息，请先核对原会话。')
    this.update(id, { state: 'sending' })
    try {
      const result = await this.host.transport.send(receipt.threadId, receipt.question, receipt.id)
      return this.update(id, { state: 'submitted', receiptId: result.receiptId })
    } catch (failure) {
      return this.update(id, { state: 'uncertain', error: (failure instanceof Error ? failure.message : '发送失败') + '；请在网页核对，不会自动重发。' })
    }
  }
  result(id: string, input: unknown) {
    const { answer } = z.object({ answer: z.string().trim().min(1).max(32000), confirmed: z.literal(true) }).strict().parse(input)
    const receipt = this.state().receipts.find(item => item.id === id)
    if (!receipt || !['submitted', 'uncertain', 'response_visible'].includes(receipt.state)) throw new Error('此消息尚未提交，不能回填回答。')
    return this.update(id, { state: 'response_visible', answer, resultSource: 'user', error: undefined })
  }
  cancel(id: string) {
    const receipt = this.state().receipts.find(item => item.id === id)
    if (receipt?.state !== 'prepared') throw new Error('只能取消尚未发送的草稿。')
    return this.update(id, { state: 'cancelled' })
  }
  async shutdown() { await Promise.allSettled([...this.pending]) }
  tools(): Tool[] {
    return [{ name: 'list_cloud_workers', description: 'List registered ChatGPT cloud workers for Q&A and non-project general content. No local directory required. Does not send messages.',
      schema: z.object({}).strict(), execute: async () => ({ workers: this.view().workers, connected: !!this.host.transport }) },
    { name: 'prepare_cloud_question', description: 'Prepare a question for an explicitly selected registered cloud worker. This only creates a local draft; the user must confirm sending in the panel. It grants no automatic external-message authority. Keep unrelated project/private context out unless the user requests it.',
      schema: Question, execute: async input => this.prepare(input) },
    { name: 'get_cloud_question_receipt', description: 'Read one cloud question draft, submission receipt or user-provided answer by its request ID. Submitted does not mean answered; userVerified is always false here.',
      schema: z.object({ requestId: z.string().uuid() }).strict(), execute: async input => this.state().receipts.find(item => item.id === (input as { requestId: string }).requestId) ?? { error: 'unknown_receipt' } }] as Tool[]
  }
}
