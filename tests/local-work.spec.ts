import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, threadKey, type Candidate } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { LocalWork, localWorkKind, localWorkTrigger } from '../src/app/local-work.ts'

const workspace = 'F:\\Github\\DSHSuperAgent'
const message = (eventId: string, workId = 'engine-adapters') => ({ eventId, workId, workspace,
  instruction: '检查原版任务流程', permission: 'read-only' as const })
function rig(enabled = true) {
  const settings = SettingsSchema.parse({ sources: { 'local-work': { config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(localWorkKind)
  const repo = new MemoryRepositories(), candidates: Candidate[] = [], starts = vi.fn(), deliver = vi.fn()
  const engine = new Engine({ repo, policy: () => settingsPolicy(settings, sources), scope: sources,
    assessor: { request: value => { candidates.push(value) } },
    executor: { start: starts, deliver, stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const work = new LocalWork({ store: repo, receive: t => engine.receive(t), sources, enabled: () => enabled })
  const accept = (eventId: string) => {
    engine.evaluateDue()
    const decision = engine.decide('local-work:' + eventId, { kind: 'accept', title: '检查任务流程', scope: '只读检查', reason: 'explicit operator' })
    const ticket = repo.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    return ticket
  }
  return { work, repo, engine, candidates, starts, deliver, accept, settings }
}
describe('local input uses upstream Engine', () => {
  it('keeps follow-ups on one Ticket, isolates work IDs, and resumes completed work', () => {
    const h = rig()
    const first = h.work.submit(message('event001'))
    const ticket = h.accept('event001')
    h.work.submit(message('event002'))
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.work.result('event002').tickets[0]?.id).toBe(ticket.id)
    h.engine.report(ticket.id, { state: 'ready', summary: '第一阶段完成' })
    h.work.submit(message('event003'))
    expect(h.repo.tickets.get(ticket.id)?.ended).toBeUndefined()
    h.work.submit(message('event004', 'different-work'))
    const other = h.accept('event004')
    expect(other.id).not.toBe(ticket.id)
    expect(first.triggerId).toBe('local-work:event001')
    expect(h.repo.tickets.list()).toHaveLength(2)
  })
  it('deduplicates retries and rejects a reused event with different content', () => {
    const h = rig()
    h.work.submit(message('event001'))
    expect(h.work.submit(message('event001')).received).toBe('duplicate')
    expect(() => h.work.submit({ ...message('event001'), instruction: '其他指令' })).toThrow(/different/)
  })
  it('requires opt-in, an allowlisted workspace, and explicit write authorization', () => {
    expect(() => rig(false).work.submit(message('event001'))).toThrow(/disabled/)
    const h = rig()
    expect(() => h.work.submit({ ...message('event001'), workspace: 'F:\\Other' })).toThrow(/workspace/i)
    expect(() => h.work.submit({ ...message('event001'), permission: 'workspace-write' })).toThrow(/authorization/i)
    expect(h.repo.triggers.get('local-work:event001')).toBeUndefined()
  })
  it('fixes permission at first input, including before any Ticket or assessment exists', () => {
    const h = rig()
    h.work.submit(message('event001'))
    expect(() => h.work.submit({ ...message('event002'), permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })).toThrow(/permission/)
    expect(h.repo.triggers.get('local-work:event002')).toBeUndefined()
    expect(h.repo.tickets.list()).toHaveLength(0)
  })
  it('does not auto-accept, bypass pause, or revive a human-stopped Ticket', () => {
    const h = rig()
    h.work.submit(message('event001'))
    expect(h.repo.tickets.list()).toHaveLength(0)
    const ticket = h.accept('event001')
    h.engine.stopTicket(ticket.id)
    h.work.submit(message('event002'))
    expect(h.repo.tickets.get(ticket.id)?.ended?.by).toBe('human')
    const p = rig(); p.settings.paused = true
    p.work.submit(message('event003')); p.engine.evaluateDue()
    expect(p.candidates).toHaveLength(0)
  })
  it('keys threads by canonical workspace and workId, not the project alone', () => {
    const a = localWorkTrigger(message('event001'))
    const b = localWorkTrigger({ ...message('event002'), workspace: 'f:/github/dshsuperagent/' })
    const c = localWorkTrigger({ ...message('event003'), workspace: 'F:\\Other' })
    expect(threadKey(a.threads[0]!)).toBe(threadKey(b.threads[0]!))
    expect(threadKey(a.threads[0]!)).not.toBe(threadKey(c.threads[0]!))
    expect(localWorkTrigger({ ...message('event004'), workspace: 'F:\\' }).meta.workspaceRoot).toBe('f:\\')
  })
})
