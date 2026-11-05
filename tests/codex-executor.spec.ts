import { afterEach, expect, it, vi } from 'vitest'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { CodexExecutor } from '../src/executor/codex.ts'
import { codexBinding } from '../src/executor/codex-state.ts'
import type { CodexConnection, CodexEvent } from '../src/executor/codex-rpc.ts'
const nativeId = '01a1a0f6-353d-7581-b6dd-077563be0280', turnId = '01a1a178-e245-74b3-b1c5-ea74d36a3a65'
const assignment = { id: 'assignment' } as Assignment
const ticket = { id: 'ticket', origin: { triggerId: 'origin' }, inputs: [] } as unknown as Ticket
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(stop => stop())) })
function harness(existing = false, options: { wrongWorkspace?: boolean; loseReceipt?: boolean; writable?: boolean; managed?: boolean; publish?: () => Promise<any> } = {}) {
  const records = new Map<string, unknown>(), listeners = new Set<(event: CodexEvent) => void>()
  const source = { source: 'local-work', text: 'Read fixture only', meta: { executor: 'codex', workspaceRoot: 'F:\\Example', workId: 'work', permission: options.writable ? 'workspace-write' : 'read-only', ...(options.writable ? { writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' } : {}), ...(existing ? { codexThreadId: nativeId } : {}) } }
  const store = { get: (key: string) => records.get(key), set: (key: string, value: unknown) => records.set(key, structuredClone(value)),
    triggers: { get: () => source }, tickets: { get: () => ticket, list: () => [ticket] } }
  const request = vi.fn(async (method: string, _params: unknown): Promise<any> => {
    if (method === 'project/list') return { data: [{ id: 'project', roots: [{ path: 'F:\\Example' }] }] }
    if (method === 'model/list') return { data: [{ model: 'native-model', isDefault: true }] }
    if (method === 'turn/start') { if (options.loseReceipt) throw Error('CODEX_RPC_RECEIPT_UNCERTAIN'); return { turn: { id: turnId } } }
    if (method === 'turn/steer' || method === 'turn/interrupt') return {}
    return { thread: { id: nativeId, cwd: options.wrongWorkspace ? 'F:\\Other' : 'F:\\Example', projectId: 'project', status: { type: 'idle' }, model: 'native-model' } }
  })
  const connection: CodexConnection = { initialize: vi.fn(async () => {}), request,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, close: vi.fn(async () => {}) }
  if (options.managed) Object.assign(source.meta, { intakeProposalId: 'managed-fixture' })
  const driver = new CodexExecutor({ store: store as never, validate: vi.fn(async () => {}), instruction: () => 'Read-only Engine task', connection: () => connection, timeoutMs: 10000, stopTimeoutMs: 10, publish: options.publish })
  cleanups.push(() => driver.shutdown())
  const completed = vi.fn(), failed = vi.fn(); driver.install({ completed, failed })
  const emit = (method: string, params: object) => { for (const listener of listeners) listener({ method, params: { threadId: nativeId, ...params } }) }
  const finish = () => {
    emit('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ state: 'ready', summary: 'Verified result', question: null }) } })
    emit('turn/completed', { turn: { id: turnId, status: 'completed' } })
  }
  return { driver, connection, request, records, completed, failed, emit, finish }
}
it('does not start an invisible managed task and retries the same binding with its original requirement after registration is repaired', async () => {
  const publish = vi.fn().mockRejectedValueOnce(Error('workspace 登记失败')).mockResolvedValue({ projectId: 'project', projectName: 'Example', verifiedAt: new Date().toISOString() })
  const h = harness(false, { managed: true, publish })
  await expect(h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})).rejects.toThrow('未开始执行')
  expect(h.request.mock.calls.some(([method]) => method === 'turn/start' || method === 'turn/steer')).toBe(false)
  expect(h.driver.binding(ticket.id)).toMatchObject({ threadId: nativeId, requests: {}, writer: { state: 'released' } })
  await h.driver.send(ticket, assignment, 'assignment:ticket:retry', '{}', () => {})
  expect(h.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
  const turn = h.request.mock.calls.find(([method]) => method === 'turn/start')?.[1] as any
  expect(turn.input[0].text).toContain('用户需求：\nRead fixture only')
  h.finish()
})
it('creates a native read-only thread, waits for completed, and bridges only its own final report', async () => {
  const h = harness(), accepted = vi.fn()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {}, accepted)
  expect(accepted).toHaveBeenCalledOnce(); expect(h.driver.running(ticket.id)).toBe(true)
  expect(h.completed).not.toHaveBeenCalled()
  expect(h.request.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
  expect(h.request.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  h.finish()
  expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: 'Verified result' }, [])
  expect(h.driver.binding(ticket.id)?.threadId).toBe(nativeId)
})
it('passes write authority to thread and turn policies and recovers a natural language result only on native completion', async () => {
  const h = harness(false, { writable: true })
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{"trigger":{"text":"duplicated preview"}}', () => {})
  expect(h.request.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({ sandbox: 'workspace-write' })
  const turn = h.request.mock.calls.find(([method]) => method === 'turn/start')?.[1] as any
  expect(turn.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: ['f:\\example'], networkAccess: false })
  expect(turn.outputSchema).toBeUndefined()
  expect(turn.input[0].text).toContain('用户需求：\nRead fixture only')
  expect(turn.input[0].text).not.toContain('duplicated preview')
  h.emit('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '工作状态：已完成\n\n已完成修改，相关验证通过。\n\n需要确认：无' } })
  expect(h.completed).not.toHaveBeenCalled()
  h.emit('turn/completed', { turn: { id: turnId, status: 'completed' } })
  expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: '已完成修改，相关验证通过。' }, [])
})
it('resumes the exact indexed native ID without exporting history and refuses a different workspace', async () => {
  const h = harness(true)
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  expect(h.request.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ threadId: nativeId, excludeTurns: true })
  expect(h.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false)
  const wrong = harness(true, { wrongWorkspace: true })
  await expect(wrong.driver.send(ticket, assignment, 'one', '{}', () => {})).rejects.toThrow('WORKSPACE_MISMATCH')
  expect(wrong.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
})
it('deduplicates a delivery and steers follow-ups into the same turn', async () => {
  const h = harness()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  await h.driver.send(ticket, assignment, 'two', '{}', () => {}, undefined, ['input-two'])
  expect(h.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  expect(h.request.mock.calls.find(([method]) => method === 'turn/steer')?.[1]).toMatchObject({ expectedTurnId: turnId })
  h.finish(); expect(h.completed.mock.calls[0]?.[3]).toEqual(['input-two'])
})
it('does not accept late native ready after a human stop', async () => {
  const h = harness()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  const stop = h.driver.stop(ticket.id, 'human stop')
  h.emit('turn/completed', { turn: { id: turnId, status: 'interrupted' } }); await stop
  h.finish(); expect(h.completed).not.toHaveBeenCalled()
  expect(h.request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(true)
})
it('retains uncertain receipts and closes the native execution connection instead of blindly resending', async () => {
  const h = harness(false, { loseReceipt: true })
  await expect(h.driver.send(ticket, assignment, 'one', '{}', () => {})).rejects.toThrow('UNCERTAIN')
  expect(h.connection.close).toHaveBeenCalled()
  await expect(h.driver.send(ticket, assignment, 'one', '{}', () => {})).rejects.toThrow('UNCERTAIN')
  expect(h.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  expect((h.records.get(codexBinding(ticket.id)) as any).requests.one.state).toBe('uncertain')
})
it('uses the last final answer when a steered native turn emits multiple final messages', async () => {
  const h = harness()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  for (const [id, summary] of [['old', 'old response'], ['new', 'follow-up response']]) h.emit('item/completed', {
    turnId, item: { id, type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ state: 'ready', summary, question: null }) },
  })
  h.emit('turn/completed', { turn: { id: turnId, status: 'completed' } })
  expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: 'follow-up response' }, [])
})
it('waits for a steer receipt before finalizing native completion and marking the incoming input read', async () => {
  const h = harness(), gate = Promise.withResolvers<unknown>()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  const original = h.request.getMockImplementation()!
  h.request.mockImplementation((method, params) => method === 'turn/steer' ? gate.promise : original(method, params))
  const sending = h.driver.send(ticket, assignment, 'two', '{}', () => {}, undefined, ['followup'])
  await vi.waitFor(() => expect(h.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(true))
  h.finish(); expect(h.completed).not.toHaveBeenCalled()
  gate.resolve({}); await sending
  await vi.waitFor(() => expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: 'Verified result' }, ['followup']))
  expect(h.driver.binding(ticket.id)?.requests.two?.state).toBe('completed')
})
it('releases a completed writer and resumes the same native identity on a fresh connection', async () => {
  const h = harness()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {}); h.finish()
  await vi.waitFor(() => expect(h.connection.close).toHaveBeenCalled())
  await vi.waitFor(() => expect(h.driver.binding(ticket.id)?.writer?.state).toBe('released'))
  await h.driver.send(ticket, assignment, 'two', '{}', () => {})
  expect(h.connection.initialize).toHaveBeenCalledTimes(2)
  expect(h.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
  expect(h.request.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ threadId: nativeId })
  h.finish()
})

it('does not resume until its writer has actually closed and never renames a resumed user-visible task', async () => {
  const h = harness(), gate = Promise.withResolvers<void>()
  vi.mocked(h.connection.close).mockImplementationOnce(() => gate.promise)
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {}); h.finish()
  expect(h.driver.binding(ticket.id)?.writer?.state).toBe('releasing')
  const next = h.driver.send(ticket, assignment, 'followup', '继续检查', () => {})
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.connection.initialize).toHaveBeenCalledTimes(1)
  gate.resolve(); await next
  expect(h.connection.initialize).toHaveBeenCalledTimes(2)
  expect(h.request.mock.calls.filter(([method]) => method === 'thread/name/set')).toHaveLength(1)
  h.finish()
})
it('preserves event order when a final item precedes steer ACK but completion arrives just after ACK', async () => {
  const h = harness(), gate = Promise.withResolvers<unknown>()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  const original = h.request.getMockImplementation()!
  h.request.mockImplementation((method, params) => method === 'turn/steer' ? gate.promise : original(method, params))
  const sending = h.driver.send(ticket, assignment, 'two', '{}', () => {}, undefined, ['followup'])
  await vi.waitFor(() => expect(h.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(true))
  h.emit('item/completed', { turnId, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ state: 'ready', summary: 'new result', question: null }) } })
  gate.resolve({}); await sending
  h.emit('turn/completed', { turn: { id: turnId, status: 'completed' } })
  await vi.waitFor(() => expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: 'new result' }, ['followup']))
  expect(h.failed).not.toHaveBeenCalled()
})
it('records confirmed interruption while cancelling a pending steer without accepting a late ready', async () => {
  const h = harness(), gate = Promise.withResolvers<unknown>()
  await h.driver.send(ticket, assignment, 'one', '{}', () => {})
  const original = h.request.getMockImplementation()!
  h.request.mockImplementation((method, params) => method === 'turn/steer' ? gate.promise : original(method, params))
  const sending = h.driver.send(ticket, assignment, 'two', '{}', () => {})
  await vi.waitFor(() => expect(h.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(true))
  const stop = h.driver.stop(ticket.id, 'human stop')
  h.emit('turn/completed', { turn: { id: turnId, status: 'interrupted' } })
  gate.resolve({}); await sending; await stop
  expect(h.driver.binding(ticket.id)?.requests.two?.state).toBe('interrupted')
  expect(h.completed).not.toHaveBeenCalled()
})
