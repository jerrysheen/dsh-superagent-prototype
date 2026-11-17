/** Read-only Ticket projection for a long-lived Bot. The original Engine remains authoritative. */
import { z } from 'zod'
import { ticketCard, preview, type TicketCardState } from './cards.ts'
import { topicTerms, type ContextTargets, type TargetCard } from './context-targets.ts'
import type { Store } from './store.ts'

export function botTicketStatus(state: TicketCardState, result?: string, question?: string, uncertain = false) {
  const [label, nextAction, retry] = (() => {
    switch (state) {
      case 'person/answer': return ['等待用户决策', '把问题带回当前对话讨论，等用户拍板后接续原工单。', 'no'] as const
      case 'person/delivery': return ['等待投递处理', '先核对原会话是否已收到输入，确认未投递后可由用户授权重试原工单。', 'after_delivery_check'] as const
      case 'person/failed': return uncertain
        ? ['执行回执未确认', '请核对原会话结果，避免重复执行。', 'no'] as const
        : ['执行失败', '先核实失败原因和已产生的副作用，再由用户决定是否重试原工单。', 'after_failure_check'] as const
      case 'person/review': return ['已交付，待验收', '核对报告和交付物。', 'no'] as const
      case 'person/blocked': return ['执行受阻', '先处理报告所列的阻塞，再接续原工单。', 'no'] as const
      case 'working': return ['正在执行', '等待本次回报。', 'no'] as const
      case 'working/queued': return ['等待执行', '等待执行器接手。', 'no'] as const
      case 'idle': return ['等待后续输入', '有新指令时可接续原工单。', 'no'] as const
      case 'completed': return ['已完成', '如需验收，可查看原报告。', 'no'] as const
      case 'merged': return ['已合并', '如需细节，可查看原报告。', 'no'] as const
      case 'closed': return ['已关闭', '如需细节，可查看历史。', 'no'] as const
      case 'dropped': return ['已放弃', '如需继续，先与用户确认范围。', 'no'] as const
      case 'stopped': return ['已停止', '等待用户决定是否另立工单。', 'no'] as const
    }
  })()
  const statusKind = {
    'person/answer': 'waiting_user_decision', 'person/delivery': 'delivery_failed',
    'person/failed': uncertain ? 'receipt_unconfirmed' : 'execution_failed',
    'person/blocked': 'blocked', 'person/review': 'awaiting_review',
    'working': 'running', 'working/queued': 'queued', 'idle': 'idle',
    'completed': 'completed', 'merged': 'merged', 'closed': 'closed', 'dropped': 'dropped', 'stopped': 'stopped',
  }[state]
  return { statusKind, summary: [label + '。', question ? '待讨论：' + question : result, nextAction].filter(Boolean).join(' '),
    needsHuman: state.startsWith('person/'), nextAction, retry }
}

export const BotTicketListQuery = z.object({
  query: z.string().trim().max(500).default(''),
  projectId: z.string().regex(/^project:[0-9a-f]{24}$/).optional(),
  state: z.enum(['active', 'ended', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(30).default(12),
}).strict()

export const BotTicketDetailQuery = z.object({
  uid: z.string().regex(/^engine:[A-Za-z0-9_-]{1,128}$/),
  assignmentOffset: z.coerce.number().int().nonnegative().default(0),
  inputOffset: z.coerce.number().int().nonnegative().default(0),
  reportAssignment: z.string().min(1).max(128).optional(),
  reportOffset: z.coerce.number().int().nonnegative().default(0),
}).strict()

/** Only Engine Tickets already indexed under a local-work project are exposed. */
export class BotTicketView {
  private revision = 0
  private readonly observers = new Set<() => void>()
  constructor(private readonly targets: ContextTargets, private readonly store: Pick<Store, 'tickets'>) {}

  changed() {
    this.revision++
    for (const notify of this.observers) notify()
  }

  waitForChange(after: number, signal: AbortSignal): Promise<number | null> {
    if (after !== this.revision || signal.aborted) return Promise.resolve(this.revision)
    if (this.observers.size >= 16) return Promise.resolve(null)
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', finish)
        this.observers.delete(finish)
        resolve(this.revision)
      }
      const timeout = setTimeout(finish, 20_000)
      this.observers.add(finish)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private record(card: TargetCard) {
    if (card.kind !== 'engine' || !card.uid.startsWith('engine:')) return undefined
    const ticket = this.store.tickets.get(card.uid.slice('engine:'.length))
    const binding = this.targets.binding(card.uid)
    return ticket && binding?.kind === 'engine-ticket' ? { card, ticket, binding } : undefined
  }

  private summary(found: NonNullable<ReturnType<BotTicketView['record']>>) {
    const { card, ticket, binding } = found
    const last = [...ticket.assignments].reverse().find(item => item.report)
    const report = last?.report
    const nativeThreadId = binding.nativeThreadId ?? binding.codexThreadId
    const current = ticket.assignments.at(-1)
    const status = ticketCard(ticket).state
    return {
      uid: card.uid,
      ticketId: ticket.id,
      title: ticket.title,
      project: { id: card.projectId, name: card.projectName, workspace: card.workspace },
      workId: typeof binding.workId === 'string' ? binding.workId : null,
      state: status,
      ...botTicketStatus(status, last?.id === current?.id && report ? preview(report.summary) : undefined,
        ticket.attention?.question, !!(binding.executor === 'codex' && binding.transport === 'desktop' && status === 'person/failed')),
      ended: !!ticket.ended,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      assignment: current ? { id: current.id, state: current.state, startedAt: current.startedAt ?? null } : null,
      executor: {
        kind: binding.executor, transport: binding.transport, permission: binding.permission ?? null,
        nativeThreadId: nativeThreadId ?? null,
        dshWorkerSessionId: binding.executor === 'dsh' ? binding.workerSessionId : null,
      },
      lastReport: report ? { assignmentId: last!.id, state: report.state, at: report.at,
        preview: preview(report.summary), fromCurrentAssignment: last!.id === current?.id } : null,
      attention: ticket.attention ? { question: ticket.attention.question } : null,
      observation: { source: 'engine_ledger', liveNativeActivity: false },
      verification: { state: 'not_recorded', independentlyVerified: false },
    }
  }

  private rows() {
    return this.targets.cards().flatMap(card => {
      const found = this.record(card)
      return found ? [{ found, summary: this.summary(found) }] : []
    })
  }

  /** Returns candidates, not a decision; never sends to an executor or resumes a session. */
  list(input: unknown) {
    const query = BotTicketListQuery.parse(input)
    const words = topicTerms(query.query)
    const rows = this.rows().flatMap(row => {
      const { found, summary } = row
      if (query.projectId && found.card.projectId !== query.projectId) return []
      if (query.state === 'active' && found.ticket.ended) return []
      if (query.state === 'ended' && !found.ticket.ended) return []
      const material = topicTerms([summary.title, found.card.summary, summary.project.name].join(' '))
      const score = [...words].filter(term => material.has(term)).length
      if (query.query && !score) return []
      return [{ summary, score }]
    }).sort((a, b) => b.score - a.score || b.summary.updatedAt.localeCompare(a.summary.updatedAt)
      || a.summary.ticketId.localeCompare(b.summary.ticketId))
    return { source: 'original_engine_tickets', readOnly: true, autoSelected: false, total: rows.length,
      summary: rows.length ? `找到 ${rows.length} 项工单。` : '没有找到匹配的工单。',
      items: rows.slice(0, query.limit).map(row => row.summary), hasMore: rows.length > query.limit }
  }

  /** Bounded facts only: no original user messages or raw tool transcripts. */
  detail(input: unknown) {
    const { uid, assignmentOffset, inputOffset, reportAssignment, reportOffset } = BotTicketDetailQuery.parse(input)
    const card = this.targets.card(uid)
    const found = card && this.record(card)
    if (!found) return undefined
    const { ticket } = found
    const selected = reportAssignment === undefined ? undefined : ticket.assignments.find(item => item.id === reportAssignment)?.report
    const next = (offset: number, size: number, total: number) => offset + size < total ? offset + size : null
    return {
      ...this.summary(found),
      execution: { directory: ticket.execution?.directory ?? null },
      assignments: [...ticket.assignments].reverse().slice(assignmentOffset, assignmentOffset + 12).map(item => ({
        id: item.id, state: item.state, createdAt: item.createdAt, startedAt: item.startedAt ?? null,
        endedAt: item.endedAt ?? null, endedReason: item.endedReason ?? null,
        report: item.report ? { state: item.report.state, at: item.report.at,
          summary: item.report.summary.slice(0, 1200), truncated: item.report.summary.length > 1200,
          remainingChars: Math.max(0, item.report.summary.length - 1200),
          nextOffset: next(0, 1200, item.report.summary.length) } : null,
      })),
      inputs: [...ticket.inputs].reverse().slice(inputOffset, inputOffset + 20).map(item => ({
        id: item.id, kind: item.kind, at: item.at, queued: ticket.undelivered.includes(item.id),
        readAt: item.kind === 'trigger' ? item.readAt ?? null : null,
      })),
      nextAssignmentOffset: next(assignmentOffset, 12, ticket.assignments.length),
      nextInputOffset: next(inputOffset, 20, ticket.inputs.length),
      remainingAssignments: Math.max(0, ticket.assignments.length - assignmentOffset - 12),
      remainingInputs: Math.max(0, ticket.inputs.length - inputOffset - 20),
      ...(reportAssignment === undefined ? {} : { reportPage: selected ? {
        assignmentId: reportAssignment, state: selected.state, at: selected.at,
        text: selected.summary.slice(reportOffset, reportOffset + 4000),
        nextOffset: next(reportOffset, 4000, selected.summary.length),
        remainingChars: Math.max(0, selected.summary.length - reportOffset - 4000),
      } : null }),
      sources: { triggerId: ticket.origin.triggerId, reportAuthority: 'engine_assignment',
        nativeToolTrace: 'not_collected', knowledgeEvidence: 'not_collected' },
    }
  }
}
