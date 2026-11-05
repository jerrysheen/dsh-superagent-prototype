/** Live observations are separate from indexed knowledge and never confer execution authority. */
import { z } from 'zod'
import { workspaceKey } from './local-work.ts'
import type { ContextTargets } from './context-targets.ts'
import type { Tool } from './tools/tool.ts'
import { CodexRpc } from '../executor/codex-rpc.ts'

export const ActivityBatch = z.object({ observedAt: z.string().datetime(), sessions: z.array(z.object({
  threadId: z.string().uuid(), workspace: z.string().min(3).max(600),
  state: z.enum(['running', 'idle', 'waiting_user', 'failed', 'unknown']),
}).strict()).min(1).max(100) }).strict()
export interface SessionActivity {
  threadId: string; workspace: string; state: 'running' | 'idle' | 'waiting_user' | 'failed' | 'unknown'
  source: 'desktop-bridge' | 'engine-driver' | 'app-server' | 'unavailable'
  observedAt: string; stale: boolean; reason: string
}
/** Desktop observations and native-owned turns; retains the last state across temporary connection gaps. */
export class SessionActivities {
  private desktop = new Map<string, SessionActivity>()
  private watchedIds = new Set<string>()
  constructor(private readonly host: { targets: ContextTargets; running?(threadId: string): boolean;
    probe?(threadId: string): Promise<{ cwd: string; status?: { type: string; activeFlags?: string[] } }>;
    now?: () => number; ttlMs?: number }) {}
  private now() { return this.host.now?.() ?? Date.now() }
  watched() { return [...this.watchedIds] }
  private watch(threadId: string) {
    this.watchedIds.delete(threadId); this.watchedIds.add(threadId)
    if (this.watchedIds.size > 100) this.watchedIds.delete(this.watchedIds.values().next().value!)
  }
  private card(threadId: string) {
    z.string().uuid().parse(threadId)
    const card = this.host.targets.card('codex:' + threadId)
    if (!card || card.archived) throw Error('Unknown or archived indexed session')
    return card
  }
  publish(input: unknown) {
    const batch = ActivityBatch.parse(input), at = Date.parse(batch.observedAt)
    if (at > this.now() + 5000 || this.now() - at > (this.host.ttlMs ?? 60000)) throw Error('Observation is stale or in the future')
    const checked = batch.sessions.map(item => {
      const card = this.card(item.threadId)
      if (workspaceKey(item.workspace) !== card.workspace) throw Error('Activity workspace mismatch')
      const prior = this.desktop.get(item.threadId)
      if (prior && Date.parse(prior.observedAt) > at) throw Error('Out-of-order observation')
      return { ...item, workspace: card.workspace, source: 'desktop-bridge' as const, observedAt: batch.observedAt, stale: false, reason: 'Desktop connector snapshot' }
    })
    checked.forEach(item => this.desktop.set(item.threadId, item))
    return { received: checked.length, observedAt: batch.observedAt }
  }
  /** Cheap view for visible sidebar rows; never spawns one native process per indexed session. */
  snapshot(input: unknown): SessionActivity[] {
    const ids = z.array(z.string().uuid()).max(100).parse(input)
    return [...new Set(ids)].map(threadId => {
      const card = this.card(threadId), observedAt = new Date(this.now()).toISOString()
      this.watch(threadId)
      if (this.host.running?.(threadId)) return { threadId, workspace: card.workspace, state: 'running', source: 'engine-driver', observedAt, stale: false, reason: 'Original Engine native turn is active' }
      const cached = this.desktop.get(threadId)
      if (cached) return { ...cached, stale: this.now() - Date.parse(cached.observedAt) > (this.host.ttlMs ?? 60000) }
      return { threadId, workspace: card.workspace, state: 'unknown', source: 'unavailable', observedAt, stale: false, reason: 'No live observation available' }
    })
  }
  async get(threadId: string): Promise<SessionActivity> {
    const card = this.card(threadId), observedAt = new Date(this.now()).toISOString()
    this.watch(threadId)
    if (this.host.running?.(threadId)) return { threadId, workspace: card.workspace, state: 'running', source: 'engine-driver', observedAt, stale: false, reason: 'Original Engine native turn is active' }
    const cached = this.desktop.get(threadId)
    if (cached) return { ...cached, stale: this.now() - Date.parse(cached.observedAt) > (this.host.ttlMs ?? 60000) }
    let rpc: CodexRpc | undefined, timer: ReturnType<typeof setTimeout> | undefined
    try {
      const read = this.host.probe ? this.host.probe(threadId) : (async () => {
        rpc = new CodexRpc(); await rpc.initialize()
        return (await rpc.request('thread/read', { threadId, includeTurns: false })).thread
      })()
      const value = await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Activity read timed out')), 5000) })])
      if (workspaceKey(value.cwd) !== card.workspace) throw Error('Workspace mismatch')
      // The independent server cannot attest that another desktop writer is idle.
      const state = value.status?.type === 'active' ? value.status.activeFlags?.length ? 'waiting_user' : 'running'
        : value.status?.type === 'systemError' ? 'failed' : 'unknown'
      return { threadId, workspace: card.workspace, state, source: 'app-server', observedAt, stale: !!cached,
        reason: state === 'unknown' ? 'External writer status unavailable; notLoaded/idle is not proof of desktop completion' : 'Native server observation' }
    } catch { return { threadId, workspace: card.workspace, state: 'unknown', source: 'unavailable', observedAt, stale: !!cached, reason: 'Live status unavailable' } }
    finally { clearTimeout(timer); await rpc?.close() }
  }
  tools(): Tool[] {
    return [{ name: 'get_session_activity', description: 'Query native session activity with source, observation time and freshness. Stale means last confirmed state, never proof of completion. An independent app-server notLoaded is not desktop idle. No history reads.',
      schema: z.object({
        threadId: z.string().uuid().describe('Native session UUID, without a codex: prefix.'),
        format: z.literal('uuid').optional().describe('Optional UUID hint; may be omitted. Does not change the session ID or activity result.'),
      }).strict(), execute: async (args: { threadId: string }) => this.get(args.threadId) } as Tool]
  }
}
