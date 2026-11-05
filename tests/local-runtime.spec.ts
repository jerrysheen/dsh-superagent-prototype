import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime } from './fixtures/host.ts'
import { LocalWork } from '../src/app/local-work.ts'
import { SettingsSchema } from '../src/policy.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'

it('starts the original master with a PowerShell-only Windows preset', async () => {
  const h = await startRuntime(undefined, { coordinationMode: 'sessions', sessionExecution: true },
    ['skill', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'])
  try { expect(h.runtime.health.runtime?.state).toBe('ready') } finally { await h.stop() }
})

it('does not create a master or execute anything when the adapter is disabled', async () => {
  const h = await startRuntime(undefined, { coordinationMode: 'sessions' })
  try {
    expect(h.runtime.configured()).toBe(true)
    expect(h.controller.create).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.list()).toHaveLength(0)
  } finally { await h.stop() }
})
it('prepares one read-only master on demand while keeping task execution disabled and silent', async () => {
  const h = await startRuntime(undefined, { coordinationMode: 'sessions', sessionExecution: false })
  try {
    const settings = h.runtime.store.settings()
    const results = await Promise.all([h.api('POST', 'master/open'), h.api('POST', 'master/open')])
    expect(results).toEqual([
      { status: 200, body: { sessionId: h.runtime.masterId } },
      { status: 200, body: { sessionId: h.runtime.masterId } },
    ])
    expect(h.controller.create).toHaveBeenCalledTimes(1)
    expect([...h.tools.get(h.runtime.masterId)!.keys()].sort()).toEqual(['orchestrator_read', 'read_knowledge', 'list_cloud_workers', 'prepare_cloud_question', 'get_cloud_question_receipt',
      'search_projects', 'search_sessions', 'get_context_card', 'get_work_binding', 'get_session_activity', 'list_deferred_work', 'list_managed_work', 'read_project_progress', 'prepare_managed_work'].sort())
    expect(h.permissions.mock.calls.every(([, permission]) => permission === 'read-only')).toBe(true)
    expect(h.runtime.store.settings()).toEqual(settings)
    expect(h.runtime.machine.sessionExecution).toBe(false)
    expect(h.runtime.store.tickets.list()).toHaveLength(0)
    expect(h.deliveries).not.toHaveBeenCalled()
    await h.api('POST', 'master/open')
    expect(h.controller.create).toHaveBeenCalledTimes(1)
  } finally { await h.stop() }
})
it('uses original router tools, worker, callbacks and reports without GitHub setup', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'local-engine-work-'))
  const h = await startRuntime(store => store.saveSettings(SettingsSchema.parse({
    sources: { 'local-work': { config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: true })
  try {
    expect(h.runtime.setup.configured()).toBe(false)
    const work = new LocalWork({ store: h.runtime.store, sources: h.runtime.sources, enabled: () => true, receive: t => h.runtime.receive(t) })
    work.submit({ eventId: 'evt1', workId: 'analysis', workspace, instruction: '只读分析' })
    await h.runtime.idle()
    expect(h.candidates()).toContain('local-work:evt1')
    await h.route({ kind: 'accept', trigger_id: 'local-work:evt1', title: '只读分析', worktree_name: 'analysis', acknowledgement: '收到，检查执行流程。' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.list()[0]!
    expect(ticket.assignments[0]?.state, ticket.assignments[0]?.report?.summary).toBe('running')
    expect(ticket.execution?.directory.toLowerCase()).toBe(workspace.toLowerCase())
    const worker = 'worker-' + ticket.id
    const target = new ContextTargets(new ContextCatalog(h.runtime.store), h.runtime.store)
    expect(target.binding('engine:' + ticket.id)).toMatchObject({ kind: 'engine-ticket', ticketId: ticket.id, workerSessionId: worker, workId: 'analysis', permission: 'read-only' })
    expect(h.tools.get(h.runtime.masterId)?.has('search_sessions')).toBe(true)
    expect(h.controller.create.mock.calls.some(([input]) => input.sessionId === worker)).toBe(true)
    expect(h.permissions.mock.calls.every(([, preset]) => preset === 'read-only')).toBe(true)
    work.submit({ eventId: 'write1', workId: 'independent-write', workspace, instruction: '独立的可写工作',
      permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })
    await h.runtime.idle()
    await expect(h.route({ kind: 'attach', trigger_id: 'local-work:write1', ticket_id: ticket.id })).rejects.toThrow(/permission/)
    expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === 'local-work:write1')).toBe(false)
    work.submit({ eventId: 'evt2', workId: 'analysis', workspace, instruction: '继续核对测试' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    expect(h.relays(worker).some(message => message.trigger_id === 'local-work:evt2')).toBe(true)
    await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '只读检查完成' })
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(work.result('evt2').tickets[0]?.ended?.outcome).toBe('completed')
  } finally {
    await h.stop()
    rmSync(workspace, { recursive: true, force: true })
  }
})
