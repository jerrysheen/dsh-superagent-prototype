/** Opt-in real native acceptance. Uses an isolated fixture Engine, never production databases or credential files. */
import { expect, it, vi } from 'vitest'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { startRuntime } from './fixtures/host.ts'
import { SettingsSchema } from '../src/policy.ts'
import { CodexRpc } from '../src/executor/codex-rpc.ts'
import { codexBinding } from '../src/executor/codex-state.ts'

it.skipIf(process.env.DSH_NATIVE_FLOW_ACCEPTANCE !== '1')('runs managed write work on the real native Codex, publishes its desktop project, releases and continues the same work', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const caller = process.env.DSH_NATIVE_ACCEPTANCE_CALLER
  if (!caller || !/^[a-f0-9-]{36}$/i.test(caller)) throw Error('An explicit native caller thread is required')
  const names = (await readdir('\\\\.\\pipe\\')).filter(name => /^codex-app-tools-[a-f0-9-]{36}$/i.test(name))
  if (names.length !== 1) throw Error('Desktop endpoint missing or ambiguous')
  const directory = join(root, '.local', 'managed-native-flow-' + randomUUID().slice(0, 8))
  await mkdir(directory, { recursive: true })
  const proof = join(directory, 'write-proof.txt'), marker = 'FLOW-' + randomUUID().slice(0, 8)
  const report: Record<string, unknown> = { kind: 'isolated-engine-real-native', browserAndDesktopUiVerified: false, directory }
  vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', undefined); vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', undefined)
  const host = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: true,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { enabled: true, config: { workspaces: [{ path: root }] } } },
    policy: { sources: { 'local-work': { allowed: [{ id: 'local-operator' }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: true })
  vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', '\\\\.\\pipe\\' + names[0]); vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', caller)
  async function api(path: string, body?: object) {
    const response = await host.sessionApi(body ? 'POST' : 'GET', path, body)
    if (response.status !== 200) throw Error('Acceptance API rejected: ' + JSON.stringify(response.body))
    return response.body as any
  }
  async function finish(proposalId: string) {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      await host.runtime.idle()
      const proposal = (await api('managed-work')).proposals.find((item: any) => item.id === proposalId)
      const ticket = proposal?.receipt?.tickets[0]
      report.last = { proposalState: proposal?.state, ticket }
      if (ticket?.requestHandled) {
        if (ticket.state !== 'completed') throw Error('Native execution did not complete: ' + ticket.state + ' ' + ticket.preview)
        if (ticket.native?.writer?.state === 'released') return ticket
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000))
    }
    throw Error('Native work, release or desktop registration timed out: ' + JSON.stringify(report.last))
  }
  try {
    const first = await api('managed-work/prepare', { mode: 'new', workspace: root, permission: 'workspace-write', transport: 'app-server',
      instruction: `读写链路验收（合成任务）\n仅在指定文件 ${proof} 写入一行 ${marker}。这是已授权的工程读写验收，请真实创建此文件并验证内容；不要修改其他文件，不读取凭据、会话历史或运行数据库，不发送外部消息，不操作桌面。完成后用要求的中文工作报告格式汇报实际结果。` })
    expect(host.runtime.store.tickets.list()).toHaveLength(0)
    await api('managed-work/confirm', { id: first.id, token: first.token, confirmed: true, startExecution: true, permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })
    const done = await finish(first.id), threadId = done.native.threadId
    expect((await readFile(proof, 'utf8')).trim()).toBe(marker)
    report.first = { ticketId: done.ticket_id, workId: first.workId, threadId, state: done.state, desktop: done.native.desktop, writer: done.native.writer, writeVerified: true }
    const metadata = new CodexRpc()
    try {
      await metadata.initialize()
      const value = await metadata.request('thread/read', { threadId, includeTurns: false })
      expect(value.thread.name).toBe('读写链路验收（合成任务）')
      expect(typeof value.thread.projectId).toBe('string')
      report.workspaceAssignmentVerified = true
      // Acquiring only our synthetic idle thread proves the old owned process released its writer.
      await metadata.request('thread/resume', { threadId, excludeTurns: true, approvalPolicy: 'never', sandbox: 'workspace-write' })
      report.nativeTitleVerified = true; report.writerReacquiredWithoutConflict = true
    } finally { await metadata.close() }
    const second = await api('managed-work/prepare', { mode: 'continue', workspace: root, targetUid: 'engine:' + done.ticket_id,
      instruction: `继续同一项读写链路验收。在验收文件 ${proof} 保留原有内容，并追加一行 CONTINUED；真实验证两行内容。不要修改其他文件，不读取凭据、会话历史或运行数据库，不发送外部消息，不操作桌面。完成后用要求的中文工作报告格式汇报实际结果。` })
    expect(second.permission).toBe('workspace-write')
    await api('managed-work/confirm', { id: second.id, token: second.token, confirmed: true, writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })
    const resumed = await finish(second.id)
    expect(resumed.ticket_id).toBe(done.ticket_id); expect(resumed.native.threadId).toBe(threadId); expect(second.workId).toBe(first.workId)
    expect((await readFile(proof, 'utf8')).trim().split(/\r?\n/)).toEqual([marker, 'CONTINUED'])
    expect(host.runtime.store.get(codexBinding(done.ticket_id))?.permission).toBe('workspace-write')
    report.second = { ticketId: resumed.ticket_id, workId: second.workId, threadId: resumed.native.threadId, state: resumed.state, writer: resumed.native.writer, sameIdentity: true, writeVerified: true }
    report.desktopRegistrationVerified = !!resumed.native.desktop && !resumed.native.desktopError
    report.desktopRegistrationError = resumed.native.desktopError
    report.status = report.desktopRegistrationVerified ? 'passed' : 'partial-native-only'
    if (process.env.DSH_REQUIRE_DESKTOP_PROJECT === '1') expect(report.desktopRegistrationVerified).toBe(true)
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message.slice(0, 500) : 'Acceptance failed'; throw error }
  finally {
    await host.stop(); vi.unstubAllEnvs()
    report.finishedAt = new Date().toISOString()
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
}, 330000)
