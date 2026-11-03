/** External AI session identities, unique-target routing and evidence-backed task receipts. No desktop or provider calls. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import { RoutingDecisionSchema, routingInputHash, type RoutingDecision, type SessionRouting } from './session-router.ts'

const Id = z.string().trim().min(1).max(200)
export const SessionCardSchema = z.object({
  uid: Id, provider: Id,
  surface: z.enum(['chatgpt', 'codex', 'other']), mode: z.enum(['chat', 'work', 'unknown']),
  projectId: z.string().max(200).nullable(), projectName: z.string().max(200).nullable(),
  threadId: z.string().max(200).nullable(), title: z.string().trim().min(1).max(500),
  summary: z.string().max(3000).default(''),
  scope: z.enum(['local', 'cloud', 'unknown']).default('unknown'),
  identity: z.enum(['machine_confirmed', 'operator_confirmed', 'unknown']),
  capabilities: z.object({ read: z.enum(['api', 'import', 'unavailable']), send: z.enum(['api', 'user', 'unavailable']) }).strict(),
  evidence: z.array(z.string().min(1).max(1000)).max(20).default([]),
  origin: z.enum(['manual', 'connector', 'test']).default('manual'),
}).strict()
export type SessionCard = z.infer<typeof SessionCardSchema>
export const TaskRequestSchema = z.object({
  requestId: Id, instruction: z.string().trim().min(1).max(20000),
  target: z.object({ uid: Id.optional(), projectId: Id.optional(), mode: z.enum(['chat', 'work']).optional() }).strict().default({}),
  demo: z.boolean().default(false),
}).strict()
export type SessionTaskRequest = z.infer<typeof TaskRequestSchema>
const TaskStatus = z.enum(['needs_target', 'unavailable', 'waiting_user', 'submitted', 'running', 'waiting_person',
  'response_visible', 'reported_ready', 'verified_done', 'uncertain', 'failed'])
export const ReceiptSchema = z.object({
  eventId: Id, sessionUid: Id, status: z.enum(['submitted', 'running', 'waiting_person', 'response_visible', 'reported_ready', 'verified_done', 'uncertain', 'failed']),
  result: z.string().max(50000).default(''), evidence: z.array(z.string().min(1).max(1000)).max(20).default([]),
  actor: z.enum(['connector', 'user']),
}).strict()
const SessionTaskSchema = z.object({
  id: Id, request: TaskRequestSchema, status: TaskStatus, target: SessionCardSchema.nullable(),
  candidates: z.array(Id), reason: z.string(), createdAt: z.string(), updatedAt: z.string(), receipts: z.array(ReceiptSchema),
  routing: RoutingDecisionSchema.optional(),
}).strict()
export type SessionTask = z.infer<typeof SessionTaskSchema>
interface HubState { sessions: SessionCard[]; tasks: SessionTask[] }
const StateSchema = z.object({ sessions: z.array(SessionCardSchema), tasks: z.array(SessionTaskSchema) }).strict()
const State = record<HubState>('session-hub:v1')

/** The local coordinator only prepares sends; an allowed connector or a user must perform and report the actual action. */
export class SessionHub {
  private readonly pending = new Map<string, { request: string; promise: Promise<SessionTask> }>()
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic'>, private readonly router?: SessionRouting) {}
  private state(): HubState {
    return StateSchema.parse(this.store.get(State) ?? { sessions: [], tasks: [] })
  }
  snapshot(): HubState { return this.state() }
  private candidates(cards: SessionCard[], request: SessionTaskRequest): SessionCard[] {
    return cards.filter(card => (!request.target.uid || card.uid === request.target.uid)
      && (!request.target.projectId || card.projectId === request.target.projectId)
      && (!request.target.mode || card.mode === request.target.mode))
  }
  /** Natural-language tasks go through the model; explicit unique selectors retain the deterministic path. */
  submitRouted(input: unknown): Promise<SessionTask> {
    const request = TaskRequestSchema.parse(input), key = JSON.stringify(request)
    const pending = this.pending.get(request.requestId)
    if (pending) {
      if (pending.request !== key) return Promise.reject(new Error('requestId is already bound to a different task'))
      return pending.promise
    }
    const promise = this.recommendAndSave(request)
    this.pending.set(request.requestId, { request: key, promise })
    void promise.finally(() => { this.pending.delete(request.requestId) }).catch(() => {})
    return promise
  }
  async idle(): Promise<void> { await Promise.allSettled([...this.pending.values()].map(entry => entry.promise)) }
  private async recommendAndSave(request: SessionTaskRequest): Promise<SessionTask> {
    const state = this.state(), prior = state.tasks.find(task => task.request.requestId === request.requestId)
    if (prior) return this.submit(request)
    const cards = this.candidates(state.sessions, request)
    if (request.target.uid || (cards.length === 1 && (request.target.projectId || request.target.mode))) return this.submit(request)
    if (!this.router) return this.save(request, { action: 'needs_confirmation', targetSessionUid: null, model: null,
      consideredUids: cards.map(card => card.uid), inputHash: '', decidedAt: new Date().toISOString(), reason: '智能路由尚未配置，请明确指定目标会话。' })
    const decision = RoutingDecisionSchema.parse(await this.router.recommend({ request, cards, tasks: state.tasks }))
    const current = this.state(), now = { request, cards: this.candidates(current.sessions, request), tasks: current.tasks }
    if (decision.inputHash !== routingInputHash(now)) {
      return this.save(request, { ...decision, action: 'needs_confirmation', targetSessionUid: null,
        reason: '推荐期间会话资料或任务状态发生变化，请重新确认目标。', errorCode: 'ROUTING_CONTEXT_CHANGED' })
    }
    return this.save(request, decision)
  }
  register(input: unknown): SessionCard {
    const card = SessionCardSchema.parse(input)
    this.store.atomic(() => {
      const state = this.state(), index = state.sessions.findIndex(item => item.uid === card.uid)
      const prior = state.sessions[index]
      if (prior && (prior.provider !== card.provider || prior.surface !== card.surface || prior.mode !== card.mode
        || prior.projectId !== card.projectId || prior.threadId !== card.threadId)) throw new Error('Session uid is already bound to a different identity')
      if (index < 0) state.sessions.push(card); else state.sessions[index] = card
      this.store.set(State, state)
    })
    return card
  }
  submit(input: unknown): SessionTask {
    const request = TaskRequestSchema.parse(input)
    return this.save(request)
  }
  private save(request: SessionTaskRequest, routing?: RoutingDecision): SessionTask {
    return this.store.atomic(() => {
      const state = this.state(), prior = state.tasks.find(task => task.request.requestId === request.requestId)
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('requestId is already bound to a different task')
        return prior
      }
      const matches = this.candidates(state.sessions, request)
      const proposed = routing ? routing.action === 'selected' ? matches.find(card => card.uid === routing.targetSessionUid) : undefined
        : matches.length === 1 ? matches[0] : undefined
      const target = proposed ?? null
      // An API-addressed native thread selected explicitly does not depend on an inferred Chat/Work label.
      const exactNativeTarget = target?.identity === 'machine_confirmed' && !!target.threadId && request.target.uid === target.uid
      const identified = target && target.identity !== 'unknown' && (target.mode !== 'unknown' || exactNativeTarget)
      const status = !target || !identified ? 'needs_target' : target.capabilities.send === 'unavailable' ? 'unavailable' : 'waiting_user'
      const reason = routing?.reason ?? (!target ? 'A unique session identity is required' : !identified ? 'Session identity or mode is not confirmed'
        : status === 'unavailable' ? 'This session has no supported send capability'
          : 'Target selected; no message has been sent. An allowed connector or user must perform the action.')
      const now = new Date().toISOString()
      const task: SessionTask = { id: randomUUID(), request, status, target, candidates: matches.map(card => card.uid), reason,
        createdAt: now, updatedAt: now, receipts: [], ...(routing ? { routing } : {}) }
      state.tasks.unshift(task); this.store.set(State, state)
      return task
    })
  }
  receipt(id: string, input: unknown): SessionTask {
    const receipt = ReceiptSchema.parse(input)
    return this.store.atomic(() => {
      const state = this.state(), task = state.tasks.find(item => item.id === id)
      if (!task) throw new Error('Task not found')
      if (!task.target || task.status === 'needs_target' || task.status === 'unavailable') throw new Error('No actionable target was selected')
      if (receipt.sessionUid !== task.target.uid) throw new Error('Receipt session does not match the frozen task target')
      const prior = task.receipts.find(item => item.eventId === receipt.eventId)
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error('eventId is already bound to a different receipt')
        return task
      }
      if (task.status === 'verified_done') throw new Error('Verified tasks cannot be overwritten')
      if (task.status === 'uncertain' && receipt.status === 'submitted') throw new Error('Uncertain sends must be checked; do not resend automatically')
      if (receipt.status === 'verified_done' && (receipt.actor !== 'user' || receipt.evidence.length === 0)) throw new Error('Completion requires user verification and evidence')
      if (receipt.status === 'submitted' && task.receipts.some(item => item.status === 'submitted')) throw new Error('A submission receipt already exists; do not submit twice')
      task.receipts.push(receipt); task.status = receipt.status; task.updatedAt = new Date().toISOString()
      this.store.set(State, state)
      return task
    })
  }
  clearDemo(): { removedSessions: number; removedTasks: number } {
    return this.store.atomic(() => {
      const state = this.state(), sessions = state.sessions.filter(card => card.origin !== 'test'), tasks = state.tasks.filter(task => !task.request.demo)
      const result = { removedSessions: state.sessions.length - sessions.length, removedTasks: state.tasks.length - tasks.length }
      this.store.set(State, { sessions, tasks }); return result
    })
  }
}
