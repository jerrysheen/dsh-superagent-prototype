import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { SettingsSchema } from '../src/policy.ts'
import { localWorkTrigger } from '../src/app/local-work.ts'

it('admits only confirmed work through the original Engine, reports real progress and resumes the same ticket and worker', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'managed-engine-work-'))
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: true,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { enabled: true, config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } } })), { coordinationMode: 'sessions', sessionExecution: true })
  try {
    const prepared = await host.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, instruction: '只读检查入口', executor: 'dsh' })
    expect(prepared.status).toBe(200); expect(host.runtime.store.tickets.list()).toHaveLength(0)
    const proposal = prepared.body
    const submitted = await host.sessionApi('POST', 'managed-work/confirm', { id: proposal.id, token: proposal.token, confirmed: true, startExecution: true })
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const receipt = submitted.body.receipt as { triggerId: string }
    await host.runtime.idle()
    await host.runtime.idle()
    const ticket = host.runtime.store.tickets.list()[0]!, worker = 'worker-' + ticket.id
    expect(ticket.assignments[0]?.state).toBe('running')
    await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '入口已核对，保留结果 MARKER-ONE' })
    expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    const ledger = await host.sessionApi('GET', 'managed-work')
    expect((ledger.body.works as { state: string; preview: string }[])[0]).toMatchObject({ state: 'completed', preview: expect.stringContaining('MARKER-ONE') })
    const followup = await host.sessionApi('POST', 'managed-work/prepare', { mode: 'continue', workspace, targetUid: 'engine:' + ticket.id, instruction: '继续核对剩余事项' })
    expect(followup.status).toBe(200)
    const confirmed = await host.sessionApi('POST', 'managed-work/confirm', { id: followup.body.id, token: followup.body.token, confirmed: true })
    expect(confirmed.status).toBe(200)
    await host.runtime.idle()
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
    const pendingFollowup = await host.sessionApi('GET', 'managed-work')
    const followupView = (pendingFollowup.body.proposals as { id: string; receipt?: { tickets: { requestHandled: boolean }[] } }[]).find(item => item.id === followup.body.id)
    expect(followupView?.receipt?.tickets[0]?.requestHandled).toBe(false)
    expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === worker && delivery.text.includes('继续核对剩余事项'))).toBe(true)
    host.step(worker)
    await host.runtime.idle()
    await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '本轮已核对，保留 MARKER-ONE' })
    const finished = await host.sessionApi('GET', 'managed-work')
    const finishedFollowup = (finished.body.proposals as { id: string; receipt?: { tickets: { requestHandled: boolean }[] } }[]).find(item => item.id === followup.body.id)
    expect(finishedFollowup?.receipt?.tickets[0]?.requestHandled).toBe(true)
    expect((followup.body.workId)).toBe(proposal.workId)
    expect(host.tools.get(host.runtime.masterId)?.has('orchestrator_settings_save')).toBe(false)
    expect(host.tools.get(host.runtime.masterId)?.has('send_cloud_question')).toBe(false)
  } finally {
    await host.stop()
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(workspace, { recursive: true, force: true })
  }
})

it('handles the Bot confirmation and cancellation routes through the original Engine', async () => {
  vi.stubEnv('DSH_MANAGED_WORK_CHAT_DISPATCH', '1')
  const token = 'fixture-only-bot-bridge-token'
  vi.stubEnv('DSH_BOT_BRIDGE_TOKEN', token)
  const headers = { 'x-superagent-bot-token': token }
  const workspace = mkdtempSync(join(tmpdir(), 'managed-bot-work-'))
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: false,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { enabled: true, config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } } })), { coordinationMode: 'sessions', sessionExecution: true })
  try {
    const prepare = (instruction: string) => host.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, executor: 'dsh', instruction })
    function action(draft: Record<string, unknown>, text: string) {
      return { draftId: draft.id, previewHash: createHash('sha256').update(JSON.stringify([draft.id, draft.mode, draft.workspace, draft.instruction,
        draft.targetUid ?? null, draft.executor, draft.transport, draft.permission, draft.workId])).digest('hex'),
        confirmation: { channel: 'chat', text, messageId: randomUUID() } }
    }
    const first = await prepare('通过 Bot 派发一项只读检查')
    const second = await prepare('通过 Bot 取消另一项只读检查')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(host.runtime.store.tickets.list()).toHaveLength(0)
    const refused = await host.sessionApi('POST', 'bot/confirm-work', action(first.body, '派发'))
    expect(refused.status).toBe(403)
    const cancelled = await host.sessionApi('POST', 'bot/cancel-work', action(second.body, '取消'), headers)
    expect(cancelled).toMatchObject({ status: 200, body: { state: 'cancelled' } })
    expect(host.runtime.store.tickets.list()).toHaveLength(0)
    const submitted = await host.sessionApi('POST', 'bot/confirm-work', action(first.body, '派发'), headers)
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const tickets = host.runtime.store.tickets.list()
    expect(tickets).toHaveLength(1)
    expect(submitted.body).toMatchObject({ state: 'submitted', instruction: first.body.instruction, receipt: { tickets: [{ ticket_id: tickets[0]!.id }] } })
    expect(submitted.body).not.toHaveProperty('token')
  } finally {
    vi.unstubAllEnvs()
    await host.stop()
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(workspace, { recursive: true, force: true })
  }
})

it('captures only new human input to the master and never imports prior history or tool notices', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'managed-master-input-'))
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: true,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { config: { workspaces: [{ path: workspace }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: false })
  try {
    await host.api('POST', 'master/open')
    const argumentsValue = { mode: 'new', workspace, executor: 'codex' }
    await expect(host.runTool(host.runtime.masterId, 'prepare_managed_work', argumentsValue)).rejects.toThrow('尚无')
    await host.ctx.emit('session/event', { id: host.runtime.masterId } as never, { type: 'user/message', data: { id: 'live-one', source: { kind: 'user' }, content: [{ type: 'text', text: '只读核对原始请求' }] } } as never)
    const prepared = await host.runTool(host.runtime.masterId, 'prepare_managed_work', argumentsValue)
    expect(prepared).toMatchObject({ instruction: '只读核对原始请求', sourceMessageId: 'live-one', state: 'draft' })
    await host.ctx.emit('session/event', { id: host.runtime.masterId } as never, { type: 'user/message', data: { id: 'notice', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具输出不能授权任务' }] } } as never)
    expect(await host.runTool(host.runtime.masterId, 'prepare_managed_work', argumentsValue)).toMatchObject({ id: prepared.id, instruction: '只读核对原始请求' })
    expect(host.runtime.store.tickets.list()).toHaveLength(0)
  } finally {
    await host.stop()
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(workspace, { recursive: true, force: true })
  }
})

it('recovers the same confirmed event after interrupted admission without releasing unrelated queued work', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'managed-admission-retry-'))
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: true,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { config: { workspaces: [{ path: workspace }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } } })), { coordinationMode: 'sessions', sessionExecution: true })
  try {
    const proposal = (await host.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, instruction: '只读受理重试', executor: 'dsh' })).body
    const confirmation = { id: proposal.id, token: proposal.token, confirmed: true, startExecution: true }
    vi.spyOn(host.runtime.engine, 'decide').mockImplementationOnce(() => { throw Error('Synthetic admission interruption') })
    expect((await host.sessionApi('POST', 'managed-work/confirm', confirmation)).status).toBe(400)
    const first = await host.sessionApi('GET', 'managed-work')
    const original = (first.body.proposals as { id: string; receipt: { triggerId: string } }[]).find(item => item.id === proposal.id)!
    await host.runtime.settings.pause(true, 'panel')
    const recovered = await host.sessionApi('POST', 'managed-work/confirm', confirmation)
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200)
    expect((recovered.body.receipt as { triggerId: string }).triggerId).toBe(original.receipt.triggerId)
    await host.runtime.idle()
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
    const ticket = host.runtime.store.tickets.list()[0]!
    await host.runTool('worker-' + ticket.id, 'orchestrator_report', { state: 'ready', summary: '受理重试通过' })
    await host.runtime.settings.pause(true, 'panel')
    host.runtime.receive(localWorkTrigger({ eventId: 'unrelated-event', workId: 'unrelated-work', workspace, instruction: '其他待处理请求' }))
    const next = (await host.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace, instruction: '独立新请求', executor: 'dsh' })).body
    const refused = await host.sessionApi('POST', 'managed-work/confirm', { id: next.id, token: next.token, confirmed: true, startExecution: true })
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining('已有待处理工作') } })
    expect(host.runtime.store.settings().paused).toBe(true)
  } finally {
    await host.stop()
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(workspace, { recursive: true, force: true })
  }
})
