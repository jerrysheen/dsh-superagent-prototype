/** Desktop-owned execution. Engine retains Tickets; this driver never acquires a native writer. */
import { family } from '../kv.ts'
import type { Assignment, Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { DesktopWorkClient, DesktopWorkSnapshot } from '../app/desktop-activity.ts'
import { codexBinding, type CodexBinding } from './codex-state.ts'
import type { NativeWorkerDriver, NativeWorkerEvents } from './native-worker.ts'
import { desktopWorkPrompt, parseDesktopReport } from './codex-format.ts'
import { workTitle } from '../app/work-instruction.ts'
import { localPermission } from './local-dsh.ts'
import { workspaceKey } from '../app/local-work.ts'

const Intent = family<{ requestId: string; state: 'sending' | 'uncertain' | 'bound'; threadId?: string }, [ticketId: string]>('desktop-work-intent:')
type Client = Pick<DesktopWorkClient, 'project' | 'create' | 'send' | 'snapshot' | 'close' | 'verifyProject'>
interface Job { ticket: Ticket; assignmentId: string; requestIds: string[]; inputIds: Set<string>; client: Client;
  cancelled: boolean; timer?: ReturnType<typeof setTimeout>; cursor?: string; errors: number; interruptedAt?: number;
  final?: DesktopWorkSnapshot['latestAssistantMessage']; reportedMessageId?: string }

/** Tracks Engine assignments through desktop-owned chats without acquiring a native writer. */
export class DesktopWorker implements NativeWorkerDriver {
  private events?: NativeWorkerEvents
  private jobs = new Map<string, Job>()
  private sends = new Map<string, Promise<void>>()
  private polls = new Set<Promise<void>>()
  private closed = false
  private detached = new Set<string>()
  private notices = new Map<string, Set<string>>()
  constructor(private readonly host: { store: Pick<Store, 'get' | 'set' | 'tickets' | 'triggers'>;
    client(): Client; validate(ticket: Ticket): Promise<void>; bound?(binding: CodexBinding, ticket: Ticket): void; pollMs?: number }) {}
  handles(ticket: Ticket) { return this.host.store.triggers.get(ticket.origin.triggerId)?.meta.transport === 'desktop' }
  binding(id: string) { return this.host.store.get(codexBinding(id)) }
  running(id: string) { return this.jobs.has(id) && this.binding(id)?.tracking !== 'waiting-user' }
  holds(id: string, requestId: string) { return ['accepted', 'completed'].includes(this.binding(id)?.requests[requestId]?.state ?? '') }
  install(events: NativeWorkerEvents) { this.events = events; return () => { this.events = undefined } }
  send(ticket: Ticket, assignment: Assignment, requestId: string, text: string, authorize: () => void, accepted?: () => void, inputIds: string[] = []) {
    const pending = (this.sends.get(ticket.id) ?? Promise.resolve()).catch(() => {}).then(() => this.sendNow(ticket, assignment, requestId, text, authorize, accepted, inputIds))
    const tracked = pending.finally(() => { if (this.sends.get(ticket.id) === tracked) this.sends.delete(ticket.id) })
    this.sends.set(ticket.id, tracked); return tracked
  }
  private async sendNow(ticket: Ticket, assignment: Assignment, requestId: string, text: string, authorize: () => void, accepted?: () => void, inputIds: string[] = []) {
    if (this.closed) throw Error('桌面派发已停止。')
    await this.host.validate(ticket); authorize()
    this.detached.delete(ticket.id)
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)!
    if (origin.meta.desktopAuthorization !== 'EXPLICIT_DESKTOP_PERMISSIONS') throw Error('尚未确认由桌面管理本次执行权限。')
    const permission = localPermission(origin), workspace = workspaceKey(String(origin.meta.workspaceRoot))
    let binding = this.binding(ticket.id)
    if (binding && (binding.transport !== 'desktop' || binding.permission !== permission || binding.workspace !== workspace)) throw Error('已有工作绑定固定，不能切换执行入口或权限。')
    const previous = binding?.requests[requestId]
    const intent = this.host.store.get(Intent(ticket.id))
    const recover = binding && requestId.startsWith('assignment:') && Object.entries(binding.requests).find(([id, receipt]) =>
      (receipt.state === 'accepted' || receipt.state === 'uncertain' && (receipt.deliveryAccepted || id === 'assignment:' + ticket.id && intent?.state === 'bound')) && !receipt.report)
    if (binding && recover) {
      binding.tracking = 'active'; binding.requests[recover[0]]!.state = 'accepted'; this.host.store.set(codexBinding(ticket.id), binding)
      accepted?.(); this.watch(ticket, assignment, recover[0], recover[1].inputIds); return
    }
    if (previous?.state === 'uncertain' || previous?.state === 'pending') throw Error('桌面发送回执不确定，请核对原会话；不会重复发送。')
    if (previous?.state === 'accepted' || previous?.state === 'completed') {
      accepted?.()
      if (previous.report) setTimeout(() => { if (!this.closed) this.events?.completed(ticket.id, assignment.id, previous.report!, previous.inputIds) }, 0)
      else this.watch(ticket, assignment, requestId, inputIds)
      return
    }
    let control: any; try { control = JSON.parse(text) } catch {}
    const lifecycleOnly = binding && (requestId.startsWith('assignment:') && control?.ticket_id && !control.trigger
      || inputIds.length > 0 && inputIds.every(id => this.host.store.tickets.get(ticket.id)?.inputs.find(input => input.id === id)?.kind === 'resumed'))
    if (binding && lifecycleOnly) {
      const notices = this.notices.get(ticket.id) ?? new Set<string>(); inputIds.forEach(id => notices.add(id)); this.notices.set(ticket.id, notices)
      binding.requests[requestId] = { assignmentId: assignment.id, state: 'completed', inputIds, at: new Date().toISOString() }
      this.host.store.set(codexBinding(ticket.id), binding); accepted?.(); return
    }
    const client = this.host.client()
    try {
      const project = await client.project(workspace)
      if (this.closed) throw Error('桌面派发已停止。')
      const inputs = inputIds.flatMap(id => {
        const input = this.host.store.tickets.get(ticket.id)?.inputs.find(input => input.id === id)
        if (input?.kind === 'trigger') return [this.host.store.triggers.get(input.triggerId)?.text ?? '']
        return input?.kind === 'text' || input?.kind === 'note' ? [input.text] : []
      })
      const contextOnly = inputIds.some(id => { const input = ticket.inputs.find(input => input.id === id); return input?.kind === 'note' || input?.kind === 'trigger' && input.context })
      let delivery: any; try { delivery = JSON.parse(text) } catch {}
      const instruction = inputs.length ? inputs.join('\n\n') : requestId.startsWith('assignment:') && !binding ? origin.text
        : typeof delivery?.text === 'string' ? delivery.text : typeof delivery?.note === 'string' ? delivery.note : text === '{}' || delivery?.ticket_id ? '继续当前工单，保留已完成结果，核对剩余事项。' : text
      const prompt = desktopWorkPrompt({ text: instruction, workspace, permission, ticketId: ticket.id, requestId, contextOnly })
      let baseline: DesktopWorkSnapshot | undefined
      const target = binding?.threadId ?? (typeof origin.meta.codexThreadId === 'string' ? origin.meta.codexThreadId : undefined)
      if (target) { await client.verifyProject(target, workspace, project.projectId); baseline = await client.snapshot(target) }
      else {
        const intent = this.host.store.get(Intent(ticket.id))
        if (intent && intent.state !== 'bound') throw Error('先前的桌面创建结果不确定，请核对；不会自动新建第二个任务。')
      }
      authorize()
      if (this.closed) throw Error('桌面派发已停止。')
      if (!target) {
        this.host.store.set(Intent(ticket.id), { requestId, state: 'sending' })
        let result: { threadId: string }
        try { result = await client.create(project.projectId, workTitle(origin.text), prompt, requestId) }
        catch (error) { this.host.store.set(Intent(ticket.id), { requestId, state: 'uncertain' }); throw error }
        binding = { ticketId: ticket.id, threadId: result.threadId, workspace, permission, transport: 'desktop', effectivePermission: 'desktop-settings',
          createdByEngine: true, named: true, requests: {}, desktop: { ...project, verifiedAt: new Date().toISOString() },
          writer: { state: 'released', observedAt: new Date().toISOString() }, tracking: 'active' }
        binding.requests[requestId] = { assignmentId: assignment.id, state: 'accepted', deliveryAccepted: true, inputIds, at: new Date().toISOString() }
        this.host.store.set(codexBinding(ticket.id), binding)
        this.host.store.set(Intent(ticket.id), { requestId, state: 'bound', threadId: result.threadId })
      } else {
        if (!binding) binding = { ticketId: ticket.id, threadId: target, workspace, permission, transport: 'desktop', effectivePermission: 'desktop-settings',
          createdByEngine: false, requests: {}, desktop: { ...project, verifiedAt: new Date().toISOString() }, writer: { state: 'released', observedAt: new Date().toISOString() } }
        binding.requests[requestId] = { assignmentId: assignment.id, state: 'pending', inputIds, at: new Date().toISOString(),
          baselineTurnId: baseline?.latestTurn?.id, baselineMessageId: baseline?.latestAssistantMessage?.id, baselineStatus: baseline?.latestTurn?.status }
        this.host.store.set(codexBinding(ticket.id), binding)
        try { await client.send(target, prompt, requestId) }
        catch (error) { binding.requests[requestId]!.state = 'uncertain'; binding.tracking = 'uncertain'; this.host.store.set(codexBinding(ticket.id), binding); throw error }
        binding.requests[requestId]!.state = 'accepted'; binding.requests[requestId]!.deliveryAccepted = true; binding.tracking = 'active'; this.host.store.set(codexBinding(ticket.id), binding)
      }
      if (this.closed || this.detached.has(ticket.id)) {
        if (this.detached.has(ticket.id)) { binding.tracking = 'detached'; this.host.store.set(codexBinding(ticket.id), binding) }
        return
      }
      this.host.bound?.(binding, ticket)
      accepted?.()
      if (!this.closed) this.watch(ticket, assignment, requestId, inputIds)
    } finally { client.close() }
  }
  private watch(ticket: Ticket, assignment: Assignment, requestId: string, inputIds: string[]) {
    inputIds = [...new Set([...inputIds, ...this.notices.get(ticket.id) ?? []])]; this.notices.delete(ticket.id)
    const active = this.jobs.get(ticket.id)
    if (active && active.assignmentId === assignment.id) { if (!active.requestIds.includes(requestId)) active.requestIds.push(requestId); inputIds.forEach(id => active.inputIds.add(id)); return }
    if (active) this.detach(active)
    const job: Job = { ticket, assignmentId: assignment.id, requestIds: [requestId], inputIds: new Set(inputIds), client: this.host.client(), cancelled: false, errors: 0 }
    this.jobs.set(ticket.id, job)
    // Let Engine commit assignmentStarted/inputsDelivered before handling a very fast desktop result.
    job.timer = setTimeout(() => this.poll(job), 0)
  }
  private poll(job: Job) {
    if (this.closed || job.cancelled || this.jobs.get(job.ticket.id) !== job) return
    const pending = this.pollOnce(job).finally(() => {
      this.polls.delete(pending)
      if (!this.closed && !job.cancelled && this.jobs.get(job.ticket.id) === job) job.timer = setTimeout(() => this.poll(job), this.host.pollMs ?? 1500)
    })
    this.polls.add(pending)
  }
  private detach(job: Job) { job.cancelled = true; clearTimeout(job.timer); job.client.close(); if (this.jobs.get(job.ticket.id) === job) this.jobs.delete(job.ticket.id) }
  private uncertain(job: Job, message: string) {
    const binding = this.binding(job.ticket.id)
    if (binding) { binding.tracking = 'uncertain'; for (const id of job.requestIds) if (binding.requests[id]) binding.requests[id]!.state = 'uncertain'; this.host.store.set(codexBinding(binding.ticketId), binding) }
    this.detach(job); this.events?.failed(job.ticket.id, job.assignmentId, Error(message))
  }
  private async pollOnce(job: Job) {
    try {
      const binding = this.binding(job.ticket.id)
      if (!binding) throw Error('Missing desktop binding')
      const snapshot = await job.client.snapshot(binding.threadId, job.cursor)
      if (job.cancelled || this.closed) return
      job.errors = 0; job.cursor = snapshot.cursor
      if (snapshot.latestAssistantMessage) job.final = snapshot.latestAssistantMessage
      const turn = snapshot.latestTurn
      if (!turn) return
      if (turn.status === 'interrupted' && !turn.completedAt) {
        job.interruptedAt ??= Date.now()
        if (Date.now() - job.interruptedAt > 30000 && snapshot.thread.status.type !== 'active') this.uncertain(job, '桌面轮次状态未确认，DSH 已停止自动跟踪；请在原桌面会话继续，不会重派。')
        return
      }
      job.interruptedAt = undefined
      if (turn.status === 'failed' || turn.status === 'interrupted') { this.uncertain(job, '桌面任务已失败或中断；请在原会话核对，不会自动重跑。'); return }
      if (turn.status !== 'completed' || !turn.completedAt || job.final?.turnId !== turn.id || job.final.id === job.reportedMessageId) return
      const requestId = job.requestIds.at(-1)!, receipt = binding.requests[requestId]!
      if (receipt.baselineTurnId === turn.id && receipt.baselineStatus === 'completed' || receipt.baselineMessageId === job.final.id) return
      let report
      try { report = parseDesktopReport(job.final.text, job.ticket.id, requestId) }
      catch (error) {
        // A direct user's later conversation is never silently imported as this work's result.
        const missingReceipt = error instanceof Error && error.message.startsWith('DESKTOP_REPORT_RECEIPT_MISMATCH')
        this.uncertain(job, missingReceipt
          ? 'DESKTOP_REPORT_RECEIPT_MISMATCH：桌面已回复，但最终回复缺少匹配的工单回执行，或回执后仍有文字。请在原会话核对结果并补齐回执，避免重复执行。'
          : 'CODEX_INVALID_FINAL_REPORT：桌面已回复，工作状态、正文、需要确认三段格式不符。请在原会话核对并补齐格式。'); return
      }
      job.reportedMessageId = job.final.id
      const normalized = { state: report.state, summary: report.summary, ...(report.question ? { question: report.question } : {}) }
      for (const id of job.requestIds) { const item = binding.requests[id]; if (item) { item.state = 'completed'; item.turnId = turn.id; item.report = normalized } }
      binding.tracking = report.state === 'blocked' ? 'waiting-user' : 'finished'; this.host.store.set(codexBinding(binding.ticketId), binding)
      if (report.state !== 'blocked') this.detach(job)
      this.events?.completed(job.ticket.id, job.assignmentId, normalized, [...job.inputIds])
    } catch {
      if (job.cancelled || this.closed) return
      if (++job.errors >= 3) this.uncertain(job, '桌面状态连接连续失败；原任务可能仍在桌面运行，DSH 不会重复派发。')
    }
  }
  async stop(ticketId: string, _reason: string) {
    this.detached.add(ticketId)
    const job = this.jobs.get(ticketId); if (job) this.detach(job)
    const binding = this.binding(ticketId)
    if (binding) { binding.tracking = 'detached'; this.host.store.set(codexBinding(ticketId), binding) }
    // Stop monitoring only. The visible desktop owns stop/continue; never seize its writer.
  }
  async shutdown() { this.closed = true; for (const job of this.jobs.values()) this.detach(job); await Promise.allSettled([...this.sends.values(), ...this.polls]); this.events = undefined }
}
