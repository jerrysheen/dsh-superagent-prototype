/** Local input/output adapters. All work ownership and lifecycle remain in core/Engine. */
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { z } from 'zod'
import { threadKey, type ReceiveResult, type Repositories, type Trigger } from '../core/index.ts'
import { AllowedSchema } from '../policy.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
export const LocalWorkspace = z.string().trim().regex(/^[A-Za-z]:[\\/]/).refine(path => win32.isAbsolute(path))
export function workspaceKey(path: string): string {
  const normalized = win32.normalize(LocalWorkspace.parse(path))
  return (normalized === win32.parse(normalized).root ? normalized : normalized.replace(/[\\]+$/, '')).toLowerCase()
}
export const LocalWorkRequest = z.object({
  eventId: Name, workId: Name, workspace: LocalWorkspace, instruction: z.string().trim().min(1).max(8000),
  permission: z.enum(['read-only', 'workspace-write']).default('read-only'),
  writeAuthorization: z.literal('EXPLICIT_WORKSPACE_WRITE').optional(),
  executor: z.enum(['dsh', 'codex']).default('dsh'),
  transport: z.enum(['app-server', 'desktop']).default('app-server'),
  desktopAuthorization: z.literal('EXPLICIT_DESKTOP_PERMISSIONS').optional(),
  codexThreadId: z.string().uuid().optional(),
  intakeProposalId: z.string().uuid().optional(), sourceMessageId: z.string().min(1).max(200).optional(),
}).strict().refine(value => value.permission !== 'workspace-write' || value.writeAuthorization === 'EXPLICIT_WORKSPACE_WRITE',
  'workspace-write requires explicit authorization').refine(value => !value.codexThreadId || value.executor === 'codex', 'codexThreadId requires the Codex executor')
  .refine(value => value.transport !== 'desktop' || value.executor === 'codex' && value.desktopAuthorization === 'EXPLICIT_DESKTOP_PERMISSIONS', 'Desktop execution requires explicit desktop permission consent')
export const LocalWorkConfig = z.object({ defaultPermission: z.enum(['read-only', 'workspace-write']).default('read-only'), workspaces: z.array(z.object({ path: LocalWorkspace }).strict()).max(100).default([]) }).strict()
export const localWorkKind: SourceKind<z.infer<typeof LocalWorkConfig>> = {
  kind: 'local-work', title: { zh: '本地工作输入', en: 'Local work input' },
  description: { zh: '将本地指令交给原版 Engine；工作目录需显式登记。', en: 'Local instructions through the original Engine; workspaces must be allowlisted.' },
  schema: LocalWorkConfig, health: [],
  fields: [{ key: 'defaultPermission', type: 'select', label: { zh: '任务默认权限（统一授权）', en: 'Default task permission (standing authorization)' }, options: [{ value: 'read-only', label: { zh: '只读', en: 'Read only' } }, { value: 'workspace-write', label: { zh: '工程读写', en: 'Workspace write' } }] }, { key: 'workspaces', type: 'rows', label: { zh: '允许的工作目录', en: 'Allowed workspaces' },
    columns: [{ key: 'path', type: 'text', label: { zh: 'Windows 绝对路径', en: 'Absolute Windows path' } }] }],
  scope: ({ meta }, config) => typeof meta.workspaceRoot === 'string'
    && config.workspaces.some(item => workspaceKey(item.path) === workspaceKey(meta.workspaceRoot as string))
    ? { listened: true, observed: false } : { listened: false, reason: 'workspace_not_allowed' },
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许的发送者', en: 'Allowed senders' }, columns: [
      { key: 'id', type: 'text', label: { zh: '身份（本地为 local-operator）', en: 'Identity (local-operator)' } },
      { key: 'name', type: 'text', optional: true, label: { zh: '显示名', en: 'Name' } },
    ] }],
    explicit: { zh: '用户通过本机接口直接提交；身份固定为 local-operator。', en: 'Direct local submission as local-operator.' },
  },
  // The original durable outbox IS the local delivery; no external account or message is involved.
  channel: { send: async () => 'sent', link: () => ({ url: '', label: { zh: '本地工作', en: 'Local work' } }) },
}
export function localWorkTrigger(input: unknown, at = new Date().toISOString()): Trigger {
  const request = LocalWorkRequest.parse(input), workspace = workspaceKey(request.workspace)
  const project = createHash('sha256').update(workspace).digest('hex').slice(0, 20)
  const thread = { source: 'local-work', id: project + '/' + request.workId }
  return { id: 'local-work:' + request.eventId, source: 'local-work', threads: [thread],
    actor: { source: 'local-work', id: 'local-operator' }, human: true, addressed: 'direct', at, text: request.instruction,
    channel: { source: 'local-work', thread: threadKey(thread), address: { workId: request.workId } },
    meta: { workspaceRoot: workspace, workId: request.workId, permission: request.permission,
      ...(request.transport === 'desktop' ? { transport: 'desktop', desktopAuthorization: request.desktopAuthorization } : {}),
      ...(request.intakeProposalId ? { intakeProposalId: request.intakeProposalId } : {}),
      ...(request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : {}),
      ...(request.executor === 'codex' ? { executor: 'codex', ...(request.codexThreadId ? { codexThreadId: request.codexThreadId } : {}) } : {}),
      ...(request.writeAuthorization ? { writeAuthorization: request.writeAuthorization } : {}) } }
}
/** Converts local requests to immutable Engine inputs and projects original Tickets back to the caller. */
export class LocalWork {
  constructor(private readonly host: {
    store: Repositories; sources: Pick<SourceRegistry, 'scope'>; enabled(): boolean; receive(trigger: Trigger): ReceiveResult
    validate?(trigger: Trigger): void
    nativeResult?(ticketId: string): unknown
  }) {}
  submit(input: unknown) {
    if (!this.host.enabled()) throw new Error('Local Engine execution is disabled; enable sessionExecution explicitly')
    const next = localWorkTrigger(input), prior = this.host.store.triggers.get(next.id)
    const trigger = prior ? { ...next, at: prior.at } : next
    this.host.validate?.(trigger)
    if (prior && JSON.stringify(prior) !== JSON.stringify(trigger)) throw new Error('eventId is already bound to different work')
    if (!this.host.sources.scope(trigger).listened) throw new Error('Local workspace is not allowed or the source is disabled')
    const thread = this.host.store.threads.get(threadKey(trigger.threads[0]!))
    const binding = JSON.stringify([trigger.meta.executor ?? 'dsh', trigger.meta.codexThreadId ?? null, ...(trigger.meta.transport === 'desktop' ? ['desktop'] : [])])
    if (thread?.meta.localExecutor !== undefined && thread.meta.localExecutor !== binding) throw new Error('Worker driver and native target are fixed; continue with the original work binding')
    if (thread?.meta.localPermission !== undefined && thread.meta.localPermission !== trigger.meta.permission) {
      throw new Error('Work permission is fixed; use a new workId for a different permission')
    }
    for (const id of thread?.subscriptions ?? []) {
      const ticket = this.host.store.tickets.get(id)
      const origin = ticket && this.host.store.triggers.get(ticket.origin.triggerId)
      if (origin && origin.meta.permission !== trigger.meta.permission) throw new Error('Work permission is fixed; use a new workId for a different permission')
    }
    const received = this.host.store.atomic(() => {
      const result = this.host.receive(trigger)
      const stored = this.host.store.threads.get(threadKey(trigger.threads[0]!))
      if (stored) this.host.store.threads.save({ ...stored, meta: { ...stored.meta, localPermission: trigger.meta.permission, localExecutor: binding } })
      return result
    })
    return { received, ...this.result(trigger.id.slice('local-work:'.length)) }
  }
  result(eventId: string) {
    Name.parse(eventId)
    const triggerId = 'local-work:' + eventId, trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) throw new Error('Unknown local work event')
    const disposition = this.host.store.triggers.disposition(triggerId)
    const decision = disposition?.decisionId ? this.host.store.decisions.get(disposition.decisionId) : undefined
    const ids = new Set([...disposition?.fanout ?? [], ...decision?.ticketId ? [decision.ticketId] : []])
    // Engine clears active ownership after a ready report; immutable Ticket inputs still identify historical delivery.
    for (const ticket of this.host.store.tickets.list()) {
      if (ticket.origin.triggerIds.includes(triggerId) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)) ids.add(ticket.id)
    }
    const tickets = [...ids].flatMap(id => this.host.store.tickets.get(id) ?? [])
    return { triggerId, disposition, decision, tickets,
      nativeExecutions: tickets.flatMap(ticket => this.host.nativeResult?.(ticket.id) ?? []) }
  }
}
