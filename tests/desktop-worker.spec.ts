import { afterEach, expect, it, vi } from 'vitest'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { DesktopWorker } from '../src/executor/desktop-worker.ts'
import { desktopReceiptToken } from '../src/executor/codex-format.ts'
import { codexBinding } from '../src/executor/codex-state.ts'

const threadId = '01a1aae9-93e7-73c0-a6b5-16c903d1e30e'
const ticket = { id: 'ticket', origin: { triggerId: 'origin' }, inputs: [] } as unknown as Ticket
const assignment = { id: 'assignment' } as Assignment
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(stop => stop())) })
function fixture() {
  const values = new Map<string, any>()
  const origin = { source: 'local-work', text: '修复已授权的工程问题', meta: { executor: 'codex', transport: 'desktop', permission: 'workspace-write',
    workspaceRoot: 'F:\\Example', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE', desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS' } }
  let snapshot: any = { thread: { id: threadId, status: { type: 'active' } }, latestTurn: { id: 'turn', status: 'inProgress' } }
  const client = { project: vi.fn(async () => ({ projectId: 'workspace', projectName: 'Example' })),
    create: vi.fn(async (_projectId: string, _title: string, _prompt: string, _requestId: string) => ({ threadId, hostId: 'local' })), send: vi.fn(async () => {}), snapshot: vi.fn(async () => snapshot), close: vi.fn(), verifyProject: vi.fn(async () => ({ threadId, projectId: 'workspace', title: 'Fixture' })) }
  const store = { get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: any) => values.set(key, structuredClone(value)),
    tickets: { get: () => ticket }, triggers: { get: () => origin } }
  const completed = vi.fn(), failed = vi.fn()
  const driver = new DesktopWorker({ store: store as never, client: () => client, validate: async () => {}, pollMs: 5 })
  driver.install({ completed, failed }); cleanups.push(() => driver.shutdown())
  const finish = (requestId = 'assignment:ticket', text?: string) => { snapshot = { thread: { id: threadId, status: { type: 'idle' } },
    latestTurn: { id: 'turn', status: 'completed', completedAt: 123 }, latestAssistantMessage: { id: 'answer-' + requestId, turnId: 'turn', phase: 'final_answer',
      text: text ?? '工作状态：已完成\n\n已完成修改并验证。\n\n需要确认：无\n工单回执：' + desktopReceiptToken(ticket.id, requestId) } } }
  return { driver, client, values, completed, failed, finish, origin, snapshot: (value: any) => { snapshot = value } }
}
it('creates in the exact desktop workspace, never acquires a writer, deduplicates admission and recovers only its matching result', async () => {
  const h = fixture(), accepted = vi.fn()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {}, accepted)
  expect(h.client.create).toHaveBeenCalledWith('workspace', '修复已授权的工程问题', expect.stringContaining('用户需求：\n修复已授权的工程问题'), 'assignment:ticket')
  expect(h.client.create.mock.calls[0]?.[2]).toContain('执行权限：由桌面当前设置管理')
  expect(h.driver.binding(ticket.id)).toMatchObject({ threadId, transport: 'desktop', effectivePermission: 'desktop-settings', writer: { state: 'released' } })
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  expect(h.client.create).toHaveBeenCalledTimes(1)
  h.finish()
  await vi.waitFor(() => expect(h.completed).toHaveBeenCalledWith(ticket.id, assignment.id, { state: 'ready', summary: '已完成修改并验证。' }, []))
  expect(h.failed).not.toHaveBeenCalled(); expect(h.driver.running(ticket.id)).toBe(false)
})
it('retains an uncertain creation receipt and never creates a duplicate after timeout', async () => {
  const h = fixture(); h.client.create.mockRejectedValue(Error('Desktop timeout'))
  await expect(h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})).rejects.toThrow('timeout')
  await expect(h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})).rejects.toThrow('不确定')
  expect(h.client.create).toHaveBeenCalledTimes(1)
  expect(h.client.send).not.toHaveBeenCalled()
})
it('does not import direct desktop chat as a completed Engine task and never resends on an uncertain result', async () => {
  const h = fixture()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  h.finish('assignment:ticket', '这是用户在桌面进行的另一项普通聊天。')
  await vi.waitFor(() => expect(h.failed).toHaveBeenCalled())
  expect(h.completed).not.toHaveBeenCalled()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  expect(h.client.create).toHaveBeenCalledTimes(1)
  expect(h.client.send).not.toHaveBeenCalled()
})
it('reconnects monitoring to the same accepted desktop task across service restart without sending a turn', async () => {
  const h = fixture()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  const prior = h.driver.binding(ticket.id)!
  const next = fixture(); next.values.set(codexBinding(ticket.id), prior)
  await next.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  expect(next.client.create).not.toHaveBeenCalled(); expect(next.client.send).not.toHaveBeenCalled()
  next.finish(); await vi.waitFor(() => expect(next.completed).toHaveBeenCalled())
})
it('stops only Engine monitoring and leaves direct desktop chat under user control', async () => {
  const h = fixture()
  await h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})
  await h.driver.stop(ticket.id, 'user')
  h.finish(); await new Promise(resolve => setTimeout(resolve, 20))
  expect(h.completed).not.toHaveBeenCalled(); expect(h.client.send).not.toHaveBeenCalled()
  expect(h.driver.binding(ticket.id)?.tracking).toBe('detached')
})
it('requires explicit consent to desktop-controlled permissions before any desktop side effect', async () => {
  const h = fixture(); delete (h.origin.meta as any).desktopAuthorization
  await expect(h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {})).rejects.toThrow('权限')
  expect(h.client.project).not.toHaveBeenCalled(); expect(h.client.create).not.toHaveBeenCalled()
})
it('does not reattach a task if tracking was stopped while desktop creation was in flight', async () => {
  const h = fixture(), gate = Promise.withResolvers<{ threadId: string; hostId: string }>(), accepted = vi.fn()
  h.client.create.mockReturnValueOnce(gate.promise)
  const sending = h.driver.send(ticket, assignment, 'assignment:ticket', '{}', () => {}, accepted)
  await vi.waitFor(() => expect(h.client.create).toHaveBeenCalled())
  await h.driver.stop(ticket.id, 'user')
  gate.resolve({ threadId, hostId: 'local' }); await sending
  expect(accepted).not.toHaveBeenCalled(); expect(h.driver.running(ticket.id)).toBe(false)
  expect(h.driver.binding(ticket.id)?.tracking).toBe('detached')
})
