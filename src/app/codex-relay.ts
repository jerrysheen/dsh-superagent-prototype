/** Explicit, allowlisted continuation of a native Codex thread. No discovery, history import or automatic retry. */
import { z } from 'zod'
import { continueDesktopCodex } from './codex-desktop-relay.ts'

export const CodexQuestionSchema = z.object({
  requestId: z.string().uuid(), threadId: z.string().uuid(),
  question: z.string().trim().max(8000), confirmed: z.literal(true), images: z.array(z.string().uuid()).max(4).optional(),
}).strict().refine(value => !!value.question || !!value.images?.length, '请填写消息或添加图片。')
export type CodexQuestion = z.infer<typeof CodexQuestionSchema>
export type CodexTransport = 'desktop_queue' | 'desktop_app' | 'native_image_queue' | 'native_user_queue'
/** A transport acknowledgment proves acceptance into a queue, not that its desktop writer has consumed it. */
export interface CodexDelivery { queueId?: string; receiptId?: string; clientUserMessageId?: string; transport: CodexTransport }
export type CodexQueued = (delivery: CodexDelivery) => void
export interface CodexReply extends Partial<CodexDelivery> { threadId: string; turnId: string; status: 'completed'; text: string }
export interface CodexRequestState { status: 'pending' | 'completed' | 'uncertain'; delivery?: CodexDelivery; reply?: CodexReply; error?: string }
export type CodexRunner = (question: CodexQuestion, onQueued?: CodexQueued) => Promise<CodexReply>
/** Carries a native-thread transport error code, stage and caller-facing diagnostic. */
export class CodexRelayError extends Error {
  constructor(readonly code: string, readonly stage: string, message: string) { super(message) }
}

/** Native desktop queue transport; does not take over the thread writer. */
export const continueCodex = continueDesktopCodex

/** Dispatches explicitly authorized native questions through the configured transport. */
export class CodexRelay {
  private readonly requests = new Map<string, { body: string; result: Promise<CodexReply>; state: CodexRequestState }>()
  private readonly busy = new Set<string>()
  constructor(private readonly allowed: readonly string[] | (() => readonly string[]),
    private readonly run: CodexRunner = (question, onQueued) => continueCodex(question, { onQueued }),
    private readonly transport: CodexTransport = 'desktop_queue') {}
  private ids() { return typeof this.allowed === 'function' ? this.allowed() : this.allowed }
  capabilities() { const ids = this.ids(); return { enabled: ids.length > 0, allowedThreadIds: ids, transport: this.transport } }
  status(requestId: string) {
    return this.requests.get(requestId)?.state ?? { status: 'unknown', error: '请求状态已丢失，请检查原会话，避免重复发送。' }
  }
  ask(input: unknown): Promise<CodexReply> {
    const question = CodexQuestionSchema.parse(input)
    if (!this.ids().includes(question.threadId)) throw new Error('此会话不在当前可续聊目录中；未发送。')
    const body = JSON.stringify(question), previous = this.requests.get(question.requestId)
    if (previous) {
      if (previous.body !== body) throw new Error('requestId 已用于不同问题。')
      return previous.result
    }
    if (this.busy.has(question.threadId)) throw new Error('此会话已有 DSH 提问正在处理。')
    if (this.requests.size >= 100) throw new Error('试点请求达到上限，请核对已发送记录后重启连接。')
    this.busy.add(question.threadId)
    const onQueued: CodexQueued = delivery => {
      const record = this.requests.get(question.requestId)
      if (record?.state.status === 'pending') record.state = { status: 'pending', delivery: { ...delivery } }
    }
    const result = Promise.resolve().then(() => this.run(question, onQueued)).finally(() => this.busy.delete(question.threadId))
    const record = { body, result, state: { status: 'pending' } as CodexRequestState }
    this.requests.set(question.requestId, record)
    void result.then(reply => { record.state = { ...record.state, status: 'completed', reply } }, error => {
      record.state = { ...record.state, status: 'uncertain', error: error instanceof Error ? error.message : '发送结果未知，请检查原会话。' }
    })
    return result
  }
}
