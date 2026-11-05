import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories } from '../src/core/index.ts'
import type { Candidate, EngineOptions, Ticket, Assignment, Trigger } from '../src/core/index.ts'
import { canonicalCursorWorkspace, cursorProjectKey, cursorSessionUid, cursorTrigger } from '../src/sources/cursor-local.ts'

const gig = 'F:\\ElexGithub\\GIGNew\\client'
const other = 'F:\\Github\\DSHSuperAgent'
const at = (n: number) => new Date(Date.UTC(2026, 10, 3, 8, 0, n)).toISOString()
const make = (eventId: string, root: string, workId: string, time: number): Trigger =>
  cursorTrigger({ eventId, root, workId, instruction: 'Read-only task ' + eventId, at: at(time) })
function rig() {
  const repo = new MemoryRepositories()
  const candidates: Candidate[] = []
  const starts: { ticket: Ticket; assignment: Assignment }[] = []
  const deliveries: string[] = []
  const engine = new Engine({
    repo,
    policy: () => ({
      version: 'local-operator-v1', paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit' as const, basis: { via: 'addressed' as const, addressed: 'direct' as const } }),
      revalidate: () => true, admitsInferred: () => false,
    }),
    scope: { scope: input => input.source === 'cursor-local' ? { listened: true, observed: false } : { listened: false, reason: 'other-source' } },
    assessor: { request: candidate => { candidates.push(candidate) } },
    executor: { start: (ticket, assignment) => { starts.push({ ticket, assignment }) },
      deliver: ticket => { deliveries.push(ticket.id) }, stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    now: () => at(50),
  } satisfies EngineOptions)
  const open = (eventId: string, root: string, workId: string, time: number) => {
    const trigger = make(eventId, root, workId, time)
    expect(engine.receive(trigger)).toBe('stored')
    engine.evaluateDue()
    const candidate = candidates.at(-1)!
    expect(candidate.triggers.map(x => x.id)).toContain(trigger.id)
    const decision = engine.decide(trigger.id, { kind: 'accept', title: 'Cursor ' + workId, scope: 'read-only',
      reason: 'explicit local operator', evalId: candidate.evalId })
    const ticket = repo.tickets.get(decision.ticketId!)!
    const pending = starts.shift()!
    expect(pending.ticket.id).toBe(ticket.id)
    engine.assignmentStarted(ticket.id, pending.assignment.id)
    return ticket
  }
  return { repo, engine, candidates, starts, deliveries, open }
}
describe('Cursor: original Engine Ticket/Thread/Assignment, no parallel SessionHub tasks', () => {
  it('keys identity by project, native session and CLI vs IDE surface', () => {
    expect(canonicalCursorWorkspace(gig)).toBe(canonicalCursorWorkspace('f:/elexgithub/gignew/client/'))
    expect(cursorProjectKey(gig)).not.toBe(cursorProjectKey(other))
    const cli = cursorSessionUid(gig, 'cli', 'session123')
    expect(cli).not.toBe(cursorSessionUid(other, 'cli', 'session123'))
    expect(cli).not.toBe(cursorSessionUid(gig, 'ide', 'session123'))
    expect(() => cursorSessionUid(gig, 'cli', '')).toThrow()
    expect(() => canonicalCursorWorkspace('relative/project')).toThrow()
    expect(() => canonicalCursorWorkspace('\\\\rooted-on-current-drive')).toThrow()
  })
  it('delivers same-work follow-up to the original Ticket, not a fresh Ticket', () => {
    const h = rig(), original = h.open('evt1', gig, 'gc-profiler', 1)
    const followup = make('evt2', gig, 'gc-profiler', 2)
    expect(h.engine.receive(followup)).toBe('stored')
    h.engine.evaluateDue()
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.repo.triggers.disposition(followup.id)?.fanout).toEqual([original.id])
    expect(h.repo.tickets.get(original.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === followup.id)).toBe(true)
  })
  it('keeps two tasks in one project and the same task label in another project separate', () => {
    const h = rig()
    const a = h.open('evt1', gig, 'gc-profiler', 1)
    const b = h.open('evt2', gig, 'shader-review', 2)
    const c = h.open('evt3', other, 'gc-profiler', 3)
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    expect(h.repo.tickets.list()).toHaveLength(3)
    expect(h.repo.threads.list()).toHaveLength(3)
  })
  it('rejects duplicate events and invalid workspace paths', () => {
    expect(() => cursorTrigger({ eventId: 'e', root: gig, workId: 'gc', instruction: ' ', at: at(1) })).toThrow()
    expect(() => cursorTrigger({ eventId: 'e', root: '../other', workId: 'gc', instruction: 'Read', at: at(1) })).toThrow()
    const h = rig()
    h.open('evt1', gig, 'gc-profiler', 1)
    expect(h.engine.receive(make('evt1', gig, 'gc-profiler', 1))).toBe('duplicate')
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
})
