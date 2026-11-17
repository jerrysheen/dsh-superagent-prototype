import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { BotTicketView, botTicketStatus } from '../src/app/bot-ticket-view.ts'

let folder: string, store: Store, reader: BotTicketView
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'bot-ticket-view-'))
  store = new Store(join(folder, 'state.sqlite'))
  reader = new BotTicketView(new ContextTargets(new ContextCatalog(store), store), store)
})
afterEach(() => { store.close(); rmSync(folder, { force: true, recursive: true }) })

function put(ticketId: string, title: string, workspace: string, source = 'local-work', ended = false) {
  const at = '2026-11-16T09:00:00Z'
  const trigger: Trigger = {
    id: 'trigger-' + ticketId, source, at, text: 'Original private instruction — not for Bot projection',
    actor: { source, id: 'local-operator' }, human: true, threads: [{ source, id: ticketId }],
    meta: { workspaceRoot: workspace, executor: 'codex', transport: 'desktop', workId: 'work-' + ticketId },
  }
  store.triggers.save(trigger)
  const ticket: Ticket = {
    id: ticketId, title, decisionId: 'decision-' + ticketId,
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'local-operator' },
      actor: trigger.actor, scope: 'read-only' },
    channels: [], inputs: [{ id: 'input-' + ticketId, kind: 'trigger', triggerId: trigger.id, at, human: true, readAt: at }],
    undelivered: [], origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    createdAt: at, updatedAt: at,
    assignments: [{ id: 'assignment-' + ticketId, state: 'running', createdAt: at, startedAt: at, report: {
      state: 'ready', summary: 'GC result with detailed checks\n' + 'R'.repeat(1600), at,
    } }],
    ...(ended ? { ended: { at, by: 'executor' as const, outcome: 'completed' as const } } : {}),
  }
  store.tickets.save(ticket)
}
it('exposes only local-work Tickets and omits original instructions and invented live state', () => {
  put('t1', 'GC 内存增长', 'F:\\Github\\LDS')
  put('t2', '另一项任务', 'F:\\Github\\Other', 'github')
  const result = reader.list({ state: 'all', query: 'GC' })
  expect(result.items.map(row => row.ticketId)).toEqual(['t1'])
  expect(JSON.stringify(result)).not.toContain('Original private instruction')
  expect(result.items[0]).toMatchObject({
    uid: 'engine:t1', state: 'person/review', executor: { kind: 'codex', nativeThreadId: null, dshWorkerSessionId: null },
    observation: { liveNativeActivity: false }, verification: { independentlyVerified: false },
  })
  expect(reader.list({ state: 'active' }).items.map(row => row.ticketId)).toEqual(['t1'])
})
it('supports ended Ticket lookup with bounded report text, without claiming independent verification', () => {
  put('t3', 'WASM 体积', 'F:\\Github\\LDS', 'local-work', true)
  expect(reader.list({}).total).toBe(0)
  const result = reader.list({ state: 'ended' })
  expect(result.items[0]).toMatchObject({ ticketId: 't3', state: 'completed',
    verification: { state: 'not_recorded', independentlyVerified: false } })
  const detail = reader.detail({ uid: 'engine:t3' })!
  expect(detail.assignments[0]!.report?.summary.length).toBeLessThanOrEqual(1200)
  expect(detail.assignments[0]!.report?.truncated).toBe(true)
  expect(reader.detail({ uid: 'engine:t3', reportAssignment: 'assignment-t3' })?.reportPage?.text.length).toBeGreaterThan(1200)
  expect(reader.detail({ uid: 'engine:t3', assignmentOffset: 1, inputOffset: 1 })).toMatchObject({ assignments: [], inputs: [] })
  expect(detail.inputs[0]).toMatchObject({ kind: 'trigger', queued: false })
  expect(JSON.stringify(detail)).not.toContain('Original private instruction')
  expect(reader.detail({ uid: 'engine:missing' })).toBeUndefined()
})
it('wakes a waiting observer on a Ticket change and releases cancelled observers', async () => {
  const abort = new AbortController()
  const initial = await reader.waitForChange(-1, abort.signal)
  if (initial === null) throw Error('initial revision missing')
  const waiting = reader.waitForChange(initial, abort.signal)
  reader.changed()
  await expect(waiting).resolves.toBe(initial + 1)
  const cancelled = reader.waitForChange(initial + 1, abort.signal)
  abort.abort()
  await expect(cancelled).resolves.toBe(initial + 1)
})
it('rejects unknown query keys, overlarge limits and invalid ticket ids', () => {
  expect(() => reader.list({ state: 'all', pretendWrite: true })).toThrow()
  expect(() => reader.list({ limit: 200 })).toThrow()
  expect(() => reader.detail({ uid: '../../credentials' })).toThrow()
  expect(store.tickets.list()).toHaveLength(0)
})

it('reconstructs the full report and every assignment and input through the advertised offsets', () => {
  put('paged', '多页报告', 'F:\\Github\\LDS')
  const ticket = store.tickets.get('paged')!
  const original = '长报告'.repeat(4000)
  ticket.assignments = Array.from({ length: 29 }, (_, i) => ({ ...ticket.assignments[0]!, id: 'assignment-' + i,
    report: { state: 'ready', at: ticket.updatedAt, summary: original } }))
  ticket.inputs = Array.from({ length: 47 }, (_, i) => ({ ...ticket.inputs[0]!, id: 'input-' + i }))
  store.tickets.save(ticket)
  const first = reader.detail({ uid: 'engine:paged' })!
  expect(first).toMatchObject({ remainingAssignments: 17, remainingInputs: 27 })
  const assignments = [...first.assignments], inputs = [...first.inputs]
  let assignmentOffset = first.nextAssignmentOffset, inputOffset = first.nextInputOffset
  while (assignmentOffset !== null) {
    const page = reader.detail({ uid: 'engine:paged', assignmentOffset })!
    assignments.push(...page.assignments)
    assignmentOffset = page.nextAssignmentOffset
  }
  while (inputOffset !== null) {
    const page = reader.detail({ uid: 'engine:paged', inputOffset })!
    inputs.push(...page.inputs)
    inputOffset = page.nextInputOffset
  }
  expect(new Set(assignments.map(row => row.id)).size).toBe(29)
  expect(new Set(inputs.map(row => row.id)).size).toBe(47)
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page: { text: string; nextOffset: number | null } = reader.detail({
      uid: 'engine:paged', reportAssignment: assignments[0]!.id, reportOffset: offset,
    })!.reportPage!
    text += page.text
    offset = page.nextOffset
  }
  expect(text).toBe(original)
})

it('separates user decisions, delivery problems and execution failure with explicit next actions', () => {
  expect(botTicketStatus('person/answer', '受阻', '选择哪一个？')).toMatchObject({
    needsHuman: true, retry: 'no', nextAction: expect.stringContaining('讨论'), summary: expect.stringContaining('选择哪一个'),
  })
  expect(botTicketStatus('person/delivery').retry).toBe('after_delivery_check')
  expect(botTicketStatus('person/failed').retry).toBe('after_failure_check')
  expect(botTicketStatus('person/failed', undefined, undefined, true).retry).toBe('no')
})
