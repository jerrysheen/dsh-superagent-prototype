import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime } from './fixtures/host.ts'
import { SettingsSchema } from '../src/policy.ts'
import { codexBinding } from '../src/executor/codex-state.ts'
const state = vi.hoisted(() => ({ creates: [] as any[], sends: [] as any[], workspace: '', final: undefined as any }))
const threadId = '01a1aae9-93e7-73c0-a6b5-16c903d1e30e'
vi.mock('../src/executor/codex-rpc.ts', () => ({ CodexRpc: class { constructor() { throw Error('Desktop tasks must never acquire an app-server writer') } } }))
vi.mock('../src/app/desktop-activity.ts', async importOriginal => ({ ...await importOriginal<any>(), DesktopWorkClient: class {
  project = async (workspace: string) => { state.workspace = workspace; return { projectId: 'desktop-project', projectName: 'Fixture' } }
  create = async (...args: any[]) => { state.creates.push(args); return { threadId, hostId: 'local' } }
  verifyProject = async () => ({ threadId, projectId: 'desktop-project', title: 'Fixture' })
  send = async (...args: any[]) => { state.sends.push(args) }
  snapshot = async () => state.final ?? { thread: { id: threadId, status: { type: 'active' } }, latestTurn: { id: 'turn', status: 'inProgress' } }
  close = () => {}
} }))

it('dispatches confirmed Engine work into a desktop-owned project task and continues the same ticket and desktop session', async () => {
  state.creates = []; state.sends = []; state.final = undefined
  const workspace = mkdtempSync(join(tmpdir(), 'desktop-engine-'))
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: false,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { enabled: true, config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: true })
  vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', '\\\\.\\pipe\\desktop-fixture'); vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', threadId)
  const finish = (prompt: string, turnId: string) => { state.final = { thread: { id: threadId, status: { type: 'idle' } }, latestTurn: { id: turnId, status: 'completed', completedAt: 123 },
    latestAssistantMessage: { id: 'final-' + turnId, turnId, phase: 'final_answer', text: '工作状态：已完成\n\n已完成工程修改。\n\n需要确认：无\n工单回执：' + prompt.match(/工单回执：([0-9a-f]{20})/)![1] } } }
  try {
    const draft = (await host.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, permission: 'workspace-write', instruction: '修复桌面入口' })).body
    expect(draft.transport).toBe('desktop')
    const confirmation = { id: draft.id, token: draft.token, confirmed: true, writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE', desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS' }
    expect((await host.sessionApi('POST', 'managed-work/confirm', confirmation)).status).toBe(200)
    await host.runtime.idle()
    const ticket = host.runtime.store.tickets.list()[0]!
    expect(state.creates).toHaveLength(1)
    expect(host.runtime.store.get(codexBinding(ticket.id))).toMatchObject({ transport: 'desktop', effectivePermission: 'desktop-settings', writer: { state: 'released' } })
    expect(host.controller.create.mock.calls.some(([request]) => request.sessionId.startsWith('worker-'))).toBe(false)
    finish(state.creates[0][2], 'first')
    await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed'), { timeout: 5000 })
    const next = (await host.sessionApi('POST', 'managed-work/prepare', { mode: 'continue', workspace, targetUid: 'engine:' + ticket.id, instruction: '继续这项工作' })).body
    expect(next.transport).toBe('desktop'); expect(next.workId).toBe(draft.workId)
    expect((await host.sessionApi('POST', 'managed-work/confirm', { ...confirmation, id: next.id, token: next.token })).status).toBe(200)
    await host.runtime.idle()
    expect(state.sends).toHaveLength(1); expect(state.sends[0][0]).toBe(threadId)
    expect(state.creates).toHaveLength(1)
    finish(state.sends[0][1], 'second')
    await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed'), { timeout: 5000 })
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
  } finally {
    await host.stop(); vi.unstubAllEnvs()
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(workspace, { recursive: true, force: true })
  }
}, 15000)
