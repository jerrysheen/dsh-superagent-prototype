import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionActivities } from '../src/app/session-activity.ts'
import { DeferredWork } from '../src/app/deferred-work.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'
const id = '01a1a4a1-9b15-7202-9b2e-36a217f5535d', workspace = 'f:\\github\\dshsuperagent'
function fixture() {
  let now = Date.parse('2026-11-04T08:00:00Z')
  const targets = { card: (uid: string) => uid === 'codex:' + id ? { workspace, archived: false } : undefined } as ContextTargets
  const probe = vi.fn(async () => ({ cwd: workspace, status: { type: 'notLoaded' } }))
  const activities = new SessionActivities({ targets, probe, now: () => now })
  const values = new Map(), store = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, structuredClone(value)) }
  const submit = vi.fn(), work = { submit }, enabled = { value: true }
  const gate = new DeferredWork({ targets, activities, store: store as never, work, enabled: () => enabled.value })
  const publish = (state: string) => activities.publish({ observedAt: new Date(now).toISOString(), sessions: [{ threadId: id, workspace, state }] })
  const request = { eventId: 'real-ui-readonly', workId: 'ui-review', workspace, executor: 'codex', codexThreadId: id, instruction: '只读检查，不修改文件', permission: 'read-only' }
  return { activities, gate, submit, publish, request, enabled, probe, targets, store, advance: () => { now += 61000 } }
}
it.each([{ threadId: id }, { threadId: id, format: 'uuid' }])('queries activity through the tool with %j', async input => {
  const h = fixture(), tool = h.activities.tools()[0]!
  h.publish('idle')
  expect(await tool.execute(tool.schema.parse(input), new AbortController().signal)).toMatchObject({
    threadId: id, workspace, state: 'idle', source: 'desktop-bridge', observedAt: '2026-11-04T08:00:00.000Z', stale: false,
  })
  h.advance()
  expect(await tool.execute(tool.schema.parse(input), new AbortController().signal)).toMatchObject({ state: 'idle', stale: true })
  expect(h.probe).not.toHaveBeenCalled()
  expect(h.submit).not.toHaveBeenCalled()
})
it('advertises an optional UUID hint while retaining strict activity arguments', () => {
  const tool = fixture().activities.tools()[0]!
  expect(z.toJSONSchema(tool.schema)).toMatchObject({
    type: 'object', additionalProperties: false, required: ['threadId'],
    properties: { threadId: { type: 'string', format: 'uuid' }, format: { type: 'string', const: 'uuid' } },
  })
  for (const input of [{ format: 'uuid' }, { threadId: 'invalid', format: 'uuid' },
    { threadId: id, format: 'json' }, { threadId: id, format: null }, { threadId: id, unexpected: true }]) {
    expect(tool.schema.safeParse(input).success).toBe(false)
  }
})
it('does not bypass indexed target checks when the UUID hint is present', async () => {
  const tool = fixture().activities.tools()[0]!
  const input = tool.schema.parse({ threadId: '01a1aac1-2431-70f1-bb9b-f93a8a70b241', format: 'uuid' })
  await expect(tool.execute(input, new AbortController().signal)).rejects.toThrow('Unknown or archived indexed session')
})
it('never interprets cross-process notLoaded as idle and marks retained desktop evidence stale', async () => {
  const h = fixture()
  expect(await h.activities.get(id)).toMatchObject({ state: 'unknown', source: 'app-server' })
  h.publish('running'); expect(await h.activities.get(id)).toMatchObject({ state: 'running', source: 'desktop-bridge', stale: false })
  h.publish('idle'); h.advance()
  expect(await h.activities.get(id)).toMatchObject({ state: 'idle', stale: true })
  h.probe.mockClear()
  expect(h.activities.snapshot([id])[0]).toMatchObject({ state: 'idle', stale: true })
  expect(h.probe).not.toHaveBeenCalled()
})
it('rejects unknown targets, mismatched workspaces, future timestamps and out-of-order observations atomically', () => {
  const h = fixture(); h.publish('running')
  const payload = { observedAt: '2026-11-04T08:00:00Z', sessions: [{ threadId: id, workspace: 'F:\\Other', state: 'idle' }] }
  expect(() => h.activities.publish(payload)).toThrow(/mismatch/)
  expect(() => h.activities.publish({ ...payload, observedAt: '2026-11-04T08:01:00Z' })).toThrow(/future/)
  expect(() => h.activities.publish({ ...payload, observedAt: '2026-11-04T07:59:59Z', sessions: [{ threadId: id, workspace, state: 'idle' }] })).toThrow(/Out-of-order/)
})
it('waits during running/unknown/attention, then delivers an immutable event once through LocalWork', async () => {
  const h = fixture(); h.gate.enqueue({ request: h.request, confirmed: true })
  for (const state of ['running', 'unknown', 'waiting_user', 'failed']) { h.publish(state); await h.gate.tick() }
  expect(h.submit).not.toHaveBeenCalled()
  h.publish('idle'); await Promise.all([h.gate.tick(), h.gate.tick()]); await h.gate.tick()
  expect(h.submit).toHaveBeenCalledOnce(); expect(h.submit.mock.calls[0]?.[0]).toMatchObject(h.request)
  expect(h.gate.list()[0]?.state).toBe('submitted')
  expect(() => h.gate.enqueue({ request: { ...h.request, instruction: 'different' }, confirmed: true })).toThrow(/immutable/)
})
it('retains deferred inputs across restart but requires new live evidence, honors pause and cancellation', async () => {
  const h = fixture(); h.gate.enqueue({ request: h.request, confirmed: true }); h.publish('idle')
  h.enabled.value = false; await h.gate.tick(); expect(h.submit).not.toHaveBeenCalled()
  const fresh = new SessionActivities({ targets: h.targets, probe: h.probe })
  const restarted = new DeferredWork({ store: h.store as never, targets: h.targets, activities: fresh, work: { submit: h.submit }, enabled: () => true })
  await restarted.tick(); expect(h.submit).not.toHaveBeenCalled()
  restarted.cancel(h.request.eventId); await restarted.tick(); expect(restarted.list()[0]?.state).toBe('cancelled')
})
it('keeps the original event ID after uncertain Source delivery and rejects write or unspecified-session inputs', async () => {
  const h = fixture(); h.publish('idle'); h.submit.mockImplementationOnce(() => { throw Error('uncertain') })
  h.gate.enqueue({ request: h.request, confirmed: true }); await h.gate.tick(); await h.gate.tick()
  expect(h.submit.mock.calls.map(call => call[0].eventId)).toEqual([h.request.eventId, h.request.eventId])
  expect(() => h.gate.enqueue({ request: { ...h.request, permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }, confirmed: true })).toThrow(/read-only/)
  expect(() => h.gate.enqueue({ request: h.request, confirmed: false })).toThrow()
})
it('does not deliver a cancelled input after an asynchronous status read finishes', async () => {
  const h = fixture(), pending = Promise.withResolvers<{ cwd: string; status: { type: string } }>()
  h.probe.mockReturnValueOnce(pending.promise)
  h.gate.enqueue({ request: h.request, confirmed: true }); const tick = h.gate.tick()
  h.gate.cancel(h.request.eventId); pending.resolve({ cwd: workspace, status: { type: 'idle' } }); await tick
  expect(h.gate.list()[0]?.state).toBe('cancelled'); expect(h.submit).not.toHaveBeenCalled()
})
it('exposes same-origin activity and waiting APIs without submitting on running evidence', async () => {
  const h = fixture(); let handler: any
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (r: any) => { handler = r.handler; return () => {} } } } as never,
    {} as never, undefined, undefined, undefined, undefined, undefined, undefined, h.activities, h.gate)
  async function call(method: string, path: string, body?: unknown, origin?: string) {
    let status = 0, value: any
    await handler({ method, url: '/session-hub/api/' + path, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...(origin ? { origin } : {}) }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})) } },
      { writeHead: (code: number) => { status = code }, end: (text: string) => { value = JSON.parse(text) } })
    return { status, value }
  }
  const observation = { observedAt: '2026-11-04T08:00:00Z', sessions: [{ threadId: id, workspace, state: 'running' }] }
  expect((await call('POST', 'activity/observe', observation, 'https://outside.example')).status).toBe(403)
  expect((await call('POST', 'activity/observe', observation)).status).toBe(200)
  expect((await call('GET', 'activity/' + id)).value).toMatchObject({ state: 'running', source: 'desktop-bridge' })
  expect((await call('POST', 'activity/query', { threadIds: [id] })).value.sessions[0]).toMatchObject({ state: 'running' })
  expect((await call('POST', 'deferred-work', { request: h.request, confirmed: true })).status).toBe(202)
  expect(h.submit).not.toHaveBeenCalled()
  expect((await call('GET', 'deferred-work')).value[0].state).toBe('waiting')
  expect((await call('POST', 'deferred-work/cancel', { eventId: h.request.eventId })).value.state).toBe('cancelled')
})
