/** Durable input gate: waits before submitting once to LocalWork; Engine still owns every task transition. */
import { z } from 'zod'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import { LocalWorkRequest, workspaceKey, type LocalWork } from './local-work.ts'
import type { SessionActivities } from './session-activity.ts'
import type { ContextTargets } from './context-targets.ts'
import type { Tool } from './tools/tool.ts'
const Request = z.object({ request: LocalWorkRequest, confirmed: z.literal(true) }).strict()
type Work = z.infer<typeof LocalWorkRequest>
interface PendingInput { request: Work; createdAt: string; state: 'waiting' | 'submitted' | 'cancelled'; reason: string }
const Inputs = record<PendingInput[]>('deferred-local-inputs:v1')
/** Retries an immutable event ID through the normal Source after fresh idle evidence; no synthetic Ticket lifecycle. */
export class DeferredWork {
  private pass?: Promise<void>
  constructor(private readonly host: { store: Pick<Store, 'get' | 'set'>; activities: SessionActivities;
    targets: ContextTargets; work: Pick<LocalWork, 'submit'>; enabled(): boolean }) {}
  list() { return structuredClone(this.host.store.get(Inputs) ?? []) }
  enqueue(input: unknown) {
    const { request } = Request.parse(input)
    if (request.executor !== 'codex' || !request.codexThreadId || request.permission !== 'read-only') throw Error('Deferred native work currently requires an exact session and read-only permission')
    const card = this.host.targets.card('codex:' + request.codexThreadId)
    if (!card || card.archived || card.workspace !== workspaceKey(request.workspace)) throw Error('Located session workspace mismatch')
    const entries = this.list(), prior = entries.find(item => item.request.eventId === request.eventId)
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw Error('Deferred event ID is immutable')
      return prior
    }
    if (entries.filter(item => item.state === 'waiting').length >= 100) throw Error('Deferred input capacity reached')
    const row: PendingInput = { request, createdAt: new Date().toISOString(), state: 'waiting', reason: 'Awaiting fresh idle observation' }
    entries.push(row); this.host.store.set(Inputs, entries); return row
  }
  cancel(eventId: string) {
    const entries = this.list(), row = entries.find(item => item.request.eventId === eventId)
    if (!row || row.state !== 'waiting') throw Error('Input is not waiting; submitted work must be stopped through Engine')
    row.state = 'cancelled'; this.host.store.set(Inputs, entries); return row
  }
  tick() { return this.pass ??= this.run().finally(() => { this.pass = undefined }) }
  private async run() {
    if (!this.host.enabled()) return
    for (const initial of this.list().filter(item => item.state === 'waiting')) {
      const activity = await this.host.activities.get(initial.request.codexThreadId!).catch(() => undefined)
      if (!this.host.enabled()) return
      // Re-read after awaits: cancellation/new inputs must not be overwritten by this pass.
      const entries = this.list(), row = entries.find(item => item.request.eventId === initial.request.eventId)
      if (!row || row.state !== 'waiting' || !this.host.enabled()) continue
      if (!activity) { row.reason = 'Waiting: indexed session unavailable' }
      else if (activity.state !== 'idle' || activity.stale) { row.reason = activity.state === 'unknown' ? 'Waiting: live status unknown' : 'Waiting: ' + activity.state }
      else {
        try { this.host.work.submit(row.request); row.state = 'submitted'; row.reason = 'Submitted to original Engine; inspect normal work result' }
        catch { row.reason = 'Normal Source rejected or submission uncertain; same event ID retained' }
      }
      this.host.store.set(Inputs, entries)
    }
  }
  tools(): Tool[] {
    return [
      { name: 'defer_session_work', description: 'With explicit user authority, defer an exact native session read-only request until fresh idle evidence. Submits through original Engine, never interrupts the external worker.', schema: Request, execute: async args => this.enqueue(args) },
      { name: 'list_deferred_work', description: 'Inspect deferred inputs and their normal Engine event IDs, not a second task lifecycle.', schema: z.object({}).strict(), execute: async () => this.list() },
      { name: 'cancel_deferred_work', description: 'Cancel an input still waiting outside Engine. Already submitted tasks use original Engine stop.', schema: z.object({ eventId: z.string().min(1).max(80) }).strict(), execute: async (args: { eventId: string }) => this.cancel(args.eventId) },
    ] as Tool[]
  }
}
