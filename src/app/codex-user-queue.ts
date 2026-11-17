/** Submit an explicit user's text and images to Codex's native user queue without taking over its writer. */
import { CodexRpc, type CodexConnection } from '../executor/codex-rpc.ts'
import type { CodexDelivery, CodexQuestion } from './codex-relay.ts'

type QueueConnection = Pick<CodexConnection, 'initialize' | 'request' | 'close'>

/** imagePaths must already be resolved from this thread's scoped upload capabilities by the HTTP boundary. */
export async function queueCodexUserMessage(question: CodexQuestion, imagePaths: readonly string[] = [],
  factory: () => QueueConnection = () => new CodexRpc()): Promise<CodexDelivery> {
  if (imagePaths.length !== (question.images?.length ?? 0) || imagePaths.some(path => !path))
    throw new Error('Codex 图片附件未完整解析；消息未发送。')
  if (!question.question && !imagePaths.length) throw new Error('Codex 消息为空；未发送。')
  const connection = factory()
  let submitted = false
  try {
    await connection.initialize()
    submitted = true
    // Fields are from the installed ThreadQueueAddParams protocol. No caller/source impersonation,
    // model/permission override, thread/resume, turn/start or queue/start is involved.
    const result = await connection.request('thread/queue/add', {
      threadId: question.threadId, clientUserMessageId: question.requestId,
      input: [
        ...(question.question ? [{ type: 'text', text: question.question, text_elements: [] }] : []),
        ...imagePaths.map(path => ({ type: 'localImage', path })),
      ],
    })
    const receipt = result?.queuedSubmission
    const input = receipt?.input
    if (typeof receipt?.id !== 'string' || !receipt.id.trim() || receipt.clientUserMessageId !== question.requestId
      || !Array.isArray(input)
      || input.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join('\n') !== question.question
      || input.filter((part: any) => part?.type === 'image' || part?.type === 'localImage').length !== imagePaths.length)
      throw new Error('未取得与本次用户消息一致的 Codex 队列回执。')
    return { receiptId: receipt.id, clientUserMessageId: receipt.clientUserMessageId, transport: 'native_user_queue' }
  } catch (error) {
    if (submitted) throw new Error((error instanceof Error ? error.message : 'Codex 队列提交失败。') + ' 提交结果未知，请检查原会话；不会自动重发。')
    throw error
  } finally { await connection.close() }
}
