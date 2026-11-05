import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime } from './fixtures/host.ts'
import { LocalWork, LocalWorkConfig } from '../src/app/local-work.ts'
import { SettingsSchema } from '../src/policy.ts'
import { codexBinding } from '../src/executor/codex-state.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { DesktopProjectClient } from '../src/app/desktop-activity.ts'
const state = vi.hoisted(() => ({ clients: [] as any[] }))
vi.mock('../src/executor/codex-rpc.ts', () => ({ CodexRpc: class {
  listeners = new Set<(event: any) => void>(); cwd = ''; turn = '01a1a178-e245-74b3-b1c5-ea74d36a3a65'
  thread = '01a1a0f6-353d-7581-b6dd-' + String(state.clients.length).padStart(12, '0')
  constructor() { state.clients.push(this) }
  initialize = async () => {}
  request = vi.fn(async (method: string, input: any) => {
    if (method === 'model/list') return { data: [{ model: 'native-model', isDefault: true }] }
    if (method === 'project/list') return { data: [{ id: 'native-project', roots: [{ path: process.env.DSH_TEST_WORKSPACE }] }] }
    if (method === 'thread/start') { this.cwd = input.cwd; return { thread: { id: this.thread, cwd: this.cwd, projectId: input.projectId } } }
    if (method === 'thread/read') return { thread: { id: input.threadId, cwd: this.cwd || process.env.DSH_TEST_WORKSPACE, status: { type: 'idle' } } }
    if (method === 'thread/resume') { this.thread = input.threadId; this.cwd ||= process.env.DSH_TEST_WORKSPACE!; return { thread: { id: this.thread, cwd: this.cwd } } }
    if (method === 'turn/start') return { turn: { id: this.turn } }
    if (method === 'turn/interrupt') this.finish('interrupted')
    return {}
  })
  subscribe = (listener: (event: any) => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  close = async () => {}
  finish(status = 'completed') {
    for (const listener of this.listeners) {
      listener({ method: 'item/completed', params: { threadId: this.thread, turnId: this.turn,
        item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ state: 'ready', summary: 'Native read-only result', question: null }) } } })
      listener({ method: 'turn/completed', params: { threadId: this.thread, turn: { id: this.turn, status } } })
    }
  }
} }))
async function harness() {
  state.clients = []
  const workspace = mkdtempSync(join(tmpdir(), 'codex-engine-'))
  const h = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ executor: { maxWorkers: 1 },
    sources: { 'local-work': { config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: true })
  const work = new LocalWork({ store: h.runtime.store, sources: h.runtime.sources, enabled: () => true, receive: t => h.runtime.receive(t) })
  const submit = (eventId: string, workId: string) => work.submit({ eventId, workId, workspace, executor: 'codex', instruction: '只读核对 fixture，不修改文件' })
  const accept = async (eventId: string) => {
    await h.runtime.idle(); await h.route({ kind: 'accept', trigger_id: 'local-work:' + eventId, title: 'Codex 只读核对', worktree_name: 'native-check', acknowledgement: '收到，核对只读数据。' })
    await h.runtime.idle()
  }
  const stop = async () => { await h.stop(); rmSync(workspace, { recursive: true, force: true }) }
  return { ...h, work, submit, accept, stop }
}
it('uses the original Engine callbacks and input flow with a native worker, without creating a DSH worker', async () => {
  const h = await harness()
  try {
    h.submit('native1', 'work'); await h.accept('native1')
    const ticket = h.runtime.store.tickets.list()[0]!
    expect(ticket.assignments[0]?.state).toBe('running')
    expect(state.clients).toHaveLength(1)
    expect(h.controller.create.mock.calls.some(([request]) => request.sessionId.startsWith('worker-'))).toBe(false)
    h.submit('native2', 'work'); await h.runtime.idle()
    expect(state.clients[0].request.mock.calls.some(([method]: [string]) => method === 'turn/steer')).toBe(true)
    state.clients[0].finish(); await h.runtime.idle()
    const result = h.work.result('native2').tickets[0]!
    expect(result.ended?.outcome).toBe('completed')
    expect(result.inputs.every(input => input.kind !== 'trigger' || input.readAt)).toBe(true)
    const targets = new ContextTargets(new ContextCatalog(h.runtime.store), h.runtime.store)
    const binding = h.runtime.store.get(codexBinding(ticket.id))!
    expect(targets.binding('codex:' + binding.threadId)).toMatchObject({ ticketId: ticket.id, nativeThreadId: binding.threadId, executor: 'codex', workId: 'work' })
    expect(targets.cards().filter(card => card.threadId === binding.threadId)).toHaveLength(1)
  } finally { await h.stop() }
})
it('keeps the original worker-slot concurrency limit across native tickets', async () => {
  const h = await harness()
  try {
    h.submit('first', 'one'); await h.accept('first')
    h.submit('second', 'two'); await h.accept('second')
    expect(state.clients).toHaveLength(1)
    state.clients[0].finish()
    await vi.waitFor(() => expect(state.clients).toHaveLength(2))
    state.clients[1].finish(); await h.runtime.idle()
    expect(h.runtime.store.tickets.list().every(ticket => ticket.ended?.outcome === 'completed')).toBe(true)
  } finally { await h.stop() }
})
it('keeps driver/native target immutable and rejects a different-driver follow-up', async () => {
  const h = await harness()
  try {
    h.submit('fixed', 'one'); await h.accept('fixed')
    expect(() => h.work.submit({ eventId: 'swap', workId: 'one', workspace: state.clients[0].cwd, instruction: '继续', executor: 'dsh' })).toThrow('driver')
    state.clients[0].finish()
  } finally { await h.stop() }
})

it('carries a user-selected writable managed request through Engine, native policies, readable dispatch, desktop registration and same-ticket continuation', async () => {
  const h = await harness(), workspace = LocalWorkConfig.parse(h.runtime.store.settings().sources['local-work']!.config).workspaces[0]!.path
  const publish = vi.spyOn(DesktopProjectClient.prototype, 'publish').mockResolvedValue({ projectId: 'desktop-project', projectName: 'Fixture', verifiedAt: new Date().toISOString() })
  vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', '\\\\.\\pipe\\dsh-fixture')
  vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', '01a1a0f6-353d-7581-b6dd-077563be0280')
  vi.stubEnv('DSH_TEST_WORKSPACE', workspace)
  try {
    const prepared = await h.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, instruction: '修复测试入口', permission: 'workspace-write', transport: 'app-server' })
    expect(prepared.status).toBe(200)
    const confirmation = { id: prepared.body.id, token: prepared.body.token, confirmed: true, writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }
    expect((await h.sessionApi('POST', 'managed-work/confirm', confirmation)).status).toBe(200)
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.list()[0]!, client = state.clients[0]
    const origin = h.runtime.store.triggers.get(ticket.origin.triggerId)!
    expect(origin.meta).toMatchObject({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })
    expect(client.request.mock.calls.find(([method]: [string]) => method === 'thread/start')[1]).toMatchObject({ sandbox: 'workspace-write', ephemeral: false, projectId: 'native-project', runtimeWorkspaceRoots: [workspace.toLowerCase()] })
    expect(client.request.mock.calls.find(([method]: [string]) => method === 'thread/name/set')[1]).toMatchObject({ name: '修复测试入口' })
    const turn = client.request.mock.calls.find(([method]: [string]) => method === 'turn/start')[1]
    expect(turn.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [workspace.toLowerCase()] })
    expect(turn.input[0].text).toContain('用户需求：\n修复测试入口')
    expect(turn.input[0].text).not.toContain('engineDelivery')
    client.finish(); await h.runtime.idle()
    await vi.waitFor(() => expect(h.runtime.store.get(codexBinding(ticket.id))?.writer?.state).toBe('released'))
    expect(publish).toHaveBeenCalled()
    expect(h.runtime.store.get(codexBinding(ticket.id))?.desktop?.projectId).toBe('desktop-project')
    const continuation = await h.sessionApi('POST', 'managed-work/prepare', { mode: 'continue', workspace, targetUid: 'engine:' + ticket.id, instruction: '继续核对修改' })
    expect(continuation.body.permission).toBe('workspace-write')
    expect((await h.sessionApi('POST', 'managed-work/confirm', { ...confirmation, id: continuation.body.id, token: continuation.body.token })).status).toBe(200)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    expect(state.clients).toHaveLength(2)
    expect(state.clients[1].thread).toBe(client.thread)
    state.clients[1].finish(); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  } finally { await h.stop(); publish.mockRestore(); vi.unstubAllEnvs() }
})
