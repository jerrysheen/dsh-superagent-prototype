/** Binds only the configured master Session to the host's native chat and composer. */
import { useEffect, useRef, useState, type ReactNode, type DragEvent } from 'react'
import type { ISessions, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewsProps, ConversationSnapshot, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRenderFactories, PropsRuntime, SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from './controls.tsx'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { WORKER_REFERENCE_MIME, readWorkerDrag, readWorkerReference, referenceChip } from './worker-references.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { superagentChat: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'superagent.agent-chat': { kind: 'single'; scope: 'session' } }
}

/** Keeps the embedded master on its chat view independently of other open Sessions. */
export function MasterChatView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Uses the shipped conversation factory, including streaming, errors, attachments and input controls. */
export function AgentChatContent({ useSession, useConversation, renderFactorySlot, inputActions, insertReference }: PropsRuntime<'superagent.agent-chat'> & PropsRenderFactories & {
  insertReference(reference: ReferenceInsert, span: TokenSpan): boolean
}) {
  const [dragging, setDragging] = useState(false), [notice, setNotice] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  async function drop(event: DragEvent) {
    if (!event.dataTransfer.types.includes(WORKER_REFERENCE_MIME)) return
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    const uid = readWorkerDrag(event.dataTransfer)
    if (!uid) { setNotice('无法识别此会话引用，请重新拖入。'); return }
    const span = inputActions.captureInsertion()
    pending.current?.abort(); const request = new AbortController(); pending.current = request
    try {
      const item = await readWorkerReference(uid, request.signal)
      if (request.signal.aborted) return
      if (!insertReference(referenceChip(item), span)) throw new Error('输入内容已变化或正在发送，请重新拖入。')
      inputActions.persistDraft()
      setNotice('已引用「' + item.title + '」；发送消息后主 Agent 才会收到。')
    } catch (failure) { if (!request.signal.aborted) setNotice(failure instanceof Error ? failure.message : '引用失败，请重新拖入。') }
  }
  const session = useSession((value: SessionSnapshot) => value)
  const conversation = useConversation((value: ConversationSnapshot) => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const hero = !active && session.openState === 'open'
  return <div className="sa-reference-chat" data-dragging={dragging || undefined}
    onDragOverCapture={event => {
      if (!event.dataTransfer.types.includes(WORKER_REFERENCE_MIME)) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragging(true)
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDropCapture={event => { void drop(event) }}>
    {dragging && <div className="sa-reference-drop-hint">松开以引用 Worker 对话</div>}
    {renderFactorySlot('conversation.content', { variant: 'embedded', phase: hero ? 'hero' : 'active', hero }, {
    slots: { views: MasterChatView }, fallback: <p className="dt-hint">对话组件尚未就绪，请稍后重新打开。</p>,
  })}
    {notice && <div className="sa-reference-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="关闭引用提示">×</button></div>}
  </div>
}

/** Retains and releases the exact master; never creates a Session or sends a prompt on mount. */
export function AgentChat({ id, sessions, SessionProvider, children, prepare }: {
  id: string; sessions: ISessions; SessionProvider: SessionProviderComponent; children: ReactNode
  prepare?: () => Promise<{ sessionId: string }>
}) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ id: string; reference?: SessionReference; error?: string }>()
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    let reference: SessionReference | undefined
    setState({ id })
    void (async () => {
      if (prepare) {
        const prepared = await prepare()
        if (prepared.sessionId !== id) throw new Error('主会话已变化，请刷新页面后重试。')
      }
      if (!active) return
      // Preparing the Host Session and hydrating the browser catalog are separate steps.
      await openKnownSession(sessions, id as SessionId, target => {
        reference = sessions.retain(target, { source: 'superagentChat', signal: controller.signal })
      }, controller.signal)
      const owned = reference
      if (!owned || !active) return
      await owned.ready
      if (active) setState({ id, reference: owned })
    })().catch(failure => {
      if (!active) return
      const error = failure instanceof SessionNavigationError ? failure.code === 'not-ready'
        ? '会话目录尚未就绪，请重新连接。' : '主会话尚未出现在目录中，请重新连接。' : String(failure)
      setState({ id, error })
    })
    return () => { active = false; controller.abort(); reference?.release() }
  }, [id, sessions, attempt, prepare])
  if (state?.id !== id || !state.reference) return <div className="sa-chat-placeholder">
    {state?.id === id && state.error ? <><p role="alert">主 Agent 对话连接失败：{state.error}</p>
      <Button onClick={() => setAttempt(value => value + 1)}>重新连接</Button></> : <p role="status">正在连接主 Agent…</p>}
  </div>
  return <SessionProvider session={state.reference}>{children}</SessionProvider>
}
