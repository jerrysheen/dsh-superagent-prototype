import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedWork } from '../src/app/managed-work.ts'
import { Store } from '../src/app/store.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'managed-work-')), store = new Store(join(directory, 'store.sqlite'))
  cleanups.push(() => { store.close(); if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup'); rmSync(directory, { recursive: true, force: true }) })
  const options: { enabled: boolean; paused: boolean; workspaces: string[]; defaultPermission?: 'read-only' | 'workspace-write'; chatDispatch?: boolean } = { enabled: true, paused: true, workspaces: ['F:\\Project'] }
  const card = { uid: 'codex:one', threadId: 'one', workspace: 'f:\\project', fingerprint: 'a'.repeat(64), title: 'Original work', archived: false }
  let binding: any = { kind: 'native-session', threadId: '01a1a0f6-353d-7581-b6dd-077563be0280' }
  const targets = { card: vi.fn(() => card), binding: vi.fn(() => binding) }
  const receipts = new Map<string, any>()
  const work = { result: vi.fn((id: string) => { if (!receipts.has(id)) throw Error('Unknown event'); return receipts.get(id) }),
    submit: vi.fn((request: any) => { receipts.set(request.eventId, { triggerId: 'local-work:' + request.eventId, tickets: [], nativeExecutions: [] }) }) }
  const activity = { state: 'idle', stale: false }
  const start = vi.fn(async () => { options.paused = false })
  const managed = new ManagedWork({ store, targets: targets as never, work: work as never, activities: { get: vi.fn(async () => activity) } as never,
    options: () => options, chatDispatch: () => options.chatDispatch === true, start })
  const input = { mode: 'new', workspace: 'F:\\Project', instruction: '只读检查原始问题', transport: 'app-server' }
  return { managed, store, input, options, targets, card, work, activity, start, bind: (value: unknown) => { binding = value } }
}
function command(draft: ReturnType<ManagedWork['prepare']>, text: string, messageId = randomUUID()) {
  const previewHash = createHash('sha256').update(JSON.stringify([draft.id, draft.mode, draft.workspace, draft.instruction,
    draft.targetUid ?? null, draft.executor, draft.transport, draft.permission, draft.workId])).digest('hex')
  return { draftId: draft.id, previewHash, confirmation: { channel: 'chat', text, messageId } }
}
it('allows only explicit existing-draft commands behind the switch and audits both outcomes', async () => {
  const { managed, store, input, options, work } = fixture()
  options.paused = false
  const audit = vi.spyOn(store, 'set')
  const draft = managed.prepare(input), next = managed.prepare({ ...input, instruction: '取消测试草案' })
  await expect(managed.botAction('confirm', command(draft, '派发'))).rejects.toThrow('未启用')
  expect(managed.list().options.chatDispatch).toBe(false)
  options.chatDispatch = true
  await expect(managed.botAction('confirm', command(draft, '不要派发'))).rejects.toThrow('明确确认')
  await expect(managed.botAction('confirm', { ...command(draft, '派发'), draftId: randomUUID() })).rejects.toThrow('不存在')
  expect(() => managed.botAction('confirm', { ...command(draft, '派发'), instruction: 'rewrite' })).toThrow()
  expect(work.submit).not.toHaveBeenCalled()
  const confirmation = command(draft, ' 派发！ ')
  await expect(managed.botAction('confirm', confirmation)).resolves.toMatchObject({ state: 'submitted', instruction: input.instruction })
  await expect(managed.botAction('confirm', command(draft, '派发'))).rejects.toThrow('已提交')
  await expect(managed.botAction('cancel', command(draft, '取消'))).rejects.toThrow('已提交')
  await expect(managed.botAction('cancel', command(next, '取消', confirmation.confirmation.messageId))).rejects.toThrow('已使用')
  await expect(managed.botAction('cancel', command(next, '取消'))).resolves.toMatchObject({ state: 'cancelled' })
  await expect(managed.botAction('confirm', command(next, '派发'))).rejects.toThrow('已取消')
  await expect(managed.botAction('cancel', command(next, '取消'))).rejects.toThrow('已取消')
  expect(work.submit).toHaveBeenCalledTimes(1)
  const auditWrites: [unknown, unknown][] = audit.mock.calls
  expect(auditWrites.filter(([key]) => String(key).startsWith('managed-work-action:')).map(([, row]) => row)).toEqual(expect.arrayContaining([
    expect.objectContaining({ draftId: draft.id, action: 'confirm', userText: ' 派发！ ', result: 'submitted', ticketId: null }),
    expect.objectContaining({ draftId: next.id, action: 'cancel', userText: '取消', result: 'cancelled', ticketId: null }),
  ]))
})
it('rejects revoked scope, stale content and paused execution through the controlled route', async () => {
  const { managed, input, options, work, start } = fixture()
  options.chatDispatch = true
  const draft = managed.prepare(input)
  await expect(managed.botAction('confirm', { ...command(draft, '派发'), previewHash: 'f'.repeat(64) })).rejects.toThrow('内容已变化')
  await expect(managed.botAction('confirm', command(draft, '派发'))).rejects.toThrow('执行已暂停')
  options.workspaces = []
  await expect(managed.botAction('confirm', command(draft, '派发'))).rejects.toThrow('尚未授权')
  await expect(managed.botAction('cancel', command(draft, '取消'))).resolves.toMatchObject({ state: 'cancelled' })
  expect(start).not.toHaveBeenCalled()
  expect(work.submit).not.toHaveBeenCalled()
})
it('keeps an indexed continuation draft when its project has not been authorized yet', async () => {
  const { managed, input, options, card, work } = fixture()
  options.workspaces = []
  const draft = managed.prepare({ ...input, mode: 'continue', targetUid: card.uid, targetFingerprint: card.fingerprint })
  const confirmation = { id: draft.id, token: draft.token, confirmed: true, startExecution: true }
  await expect(managed.confirm(confirmation)).rejects.toThrow('草案已保留')
  expect(work.submit).not.toHaveBeenCalled()
  options.workspaces = [input.workspace]
  await expect(managed.confirm(confirmation)).resolves.toMatchObject({ state: 'submitted', targetUid: card.uid })
  expect(work.submit).toHaveBeenCalledTimes(1)
})
it('prepares a deduplicated proposal without admitting work and rejects inferred project authority', () => {
  const { managed, input, work } = fixture()
  const proposal = managed.prepare(input)
  expect(managed.prepare(input).id).toBe(proposal.id)
  expect(proposal).toMatchObject({ mode: 'new', permission: 'read-only', executor: 'codex', state: 'draft' })
  expect(work.submit).not.toHaveBeenCalled()
  expect(() => managed.prepare({ ...input, workspace: 'F:\\Other' })).toThrow('尚未授权')
  expect(() => managed.prepare({ ...input, targetUid: 'codex:one' })).toThrow()
  expect(() => managed.prepare({ ...input, mode: 'continue' })).toThrow()
})

it('retains submitted status after confirmation when the Engine receipt is temporarily unavailable', async () => {
  const { managed, input, work } = fixture()
  const draft = managed.prepare(input)
  work.submit.mockImplementationOnce(() => { throw Error('Synthetic intake failure') })
  await expect(managed.confirm({ id: draft.id, token: draft.token, confirmed: true, startExecution: true }))
    .rejects.toThrow('Synthetic intake failure')
  expect(managed.draft(draft.id)).toMatchObject({ state: 'submitted', receipt: undefined })
  expect(managed.summaries(true)).toEqual([])
  expect(managed.list().proposals[0]?.state).toBe('submitted')
})

it('reads a draft older than the list window without returning other drafts or full native reports', () => {
  const { managed, input, work } = fixture()
  const first = managed.prepare(input)
  for (let i = 0; i < 35; i++) managed.prepare({ ...input, instruction: '独立草案 ' + i })
  expect(managed.list().proposals.some(row => row.id === first.id)).toBe(false)
  expect(managed.draft(first.id)).toMatchObject({ id: first.id, instruction: input.instruction })
  expect(managed.draft(first.id)).not.toHaveProperty('token')
  work.result.mockReturnValue({ triggerId: 'trigger', tickets: [],
    nativeExecutions: [{ report: { summary: 'R'.repeat(200_000) } }] } as never)
  const detail = managed.draft(first.id)!
  expect(detail.receipt?.nativeExecutionCount).toBe(1)
  expect(JSON.stringify(detail).length).toBeLessThan(4000)
  expect(detail.receipt).not.toHaveProperty('nativeExecutions')
  expect(managed.summaries(false)).toHaveLength(20)
  expect(managed.summaries(true)).toHaveLength(0)
})
it('defaults new Codex work to the desktop and requires explicit consent to its permission ownership', async () => {
  const { managed, input, work } = fixture()
  const proposal = managed.prepare({ ...input, transport: undefined })
  expect(proposal.transport).toBe('desktop')
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true, startExecution: true })).rejects.toThrow('desktop permission consent')
  expect(work.submit).not.toHaveBeenCalled()
  await managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true, startExecution: true, desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS' })
  expect(work.submit).toHaveBeenCalledWith(expect.objectContaining({ transport: 'desktop', desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS' }))
})
it('requires an exact user confirmation and explicit pause release, then submits once under concurrent retries', async () => {
  const { managed, input, work, start } = fixture(), proposal = managed.prepare(input)
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: false })).rejects.toThrow()
  await expect(managed.confirm({ id: proposal.id, token: 'b'.repeat(64), confirmed: true })).rejects.toThrow('已失效')
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true })).rejects.toThrow('执行已暂停')
  const confirmation = { id: proposal.id, token: proposal.token, confirmed: true, startExecution: true }
  await Promise.all([managed.confirm(confirmation), managed.confirm(confirmation)])
  expect(work.submit).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1)
  expect(managed.list().proposals[0]).toMatchObject({ state: 'submitted', receipt: { tickets: [] } })
})
it('uses only the captured live request and exposes no model-side confirmation or arbitrary rewritten instruction', async () => {
  const { managed, input, work } = fixture(), tool = managed.tools().find(tool => tool.name === 'prepare_managed_work')!
  await expect(tool.execute({ mode: 'new', workspace: input.workspace }, new AbortController().signal)).rejects.toThrow('尚无')
  managed.capture('current-user-message', '原始请求，不要扩大范围')
  const proposal = await tool.execute(tool.schema.parse({ mode: 'new', workspace: input.workspace }), new AbortController().signal)
  expect(proposal).toMatchObject({ instruction: '原始请求，不要扩大范围', sourceMessageId: 'current-user-message', state: 'draft' })
  expect(tool.schema.safeParse({ mode: 'new', workspace: input.workspace, instruction: 'model rewrite' }).success).toBe(false)
  expect(managed.tools().some(tool => /confirm|submit/.test(tool.name))).toBe(false)
  expect(work.submit).not.toHaveBeenCalled()
  managed.capture('image-message', '检查图片', true)
  await expect(tool.execute({ mode: 'new', workspace: input.workspace }, new AbortController().signal)).rejects.toThrow('图片不会被静默丢弃')
})
it('blocks cancelled drafts and revoked workspace scopes without submitting', async () => {
  const { managed, input, options, work } = fixture(), proposal = managed.prepare(input)
  managed.cancel(proposal.id)
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true, startExecution: true })).rejects.toThrow('已取消')
  const next = managed.prepare(input); options.workspaces = []
  await expect(managed.confirm({ id: next.id, token: next.token, confirmed: true, startExecution: true })).rejects.toThrow('尚未授权派发')
  expect(work.submit).not.toHaveBeenCalled()
})
it('continues the original work identity and driver rather than creating a parallel native binding', async () => {
  const { managed, input, bind, options, work } = fixture()
  options.paused = false
  bind({ kind: 'engine-ticket', ticketId: 'old', workId: 'original-work', executor: 'codex', permission: 'read-only', nativeThreadId: 'native-owned' })
  const proposal = managed.prepare({ ...input, mode: 'continue', targetUid: 'engine:old' })
  await managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true })
  expect(work.submit).toHaveBeenCalledWith(expect.objectContaining({ workId: 'original-work', executor: 'codex' }))
  expect(work.submit.mock.calls[0]?.[0].codexThreadId).toBeUndefined()
})
it.each([{ state: 'running', stale: false }, { state: 'unknown', stale: false }, { state: 'idle', stale: true }])('never takes over an unbound session with activity %j', async observation => {
  const { managed, input, activity, work } = fixture()
  Object.assign(activity, observation)
  const proposal = managed.prepare({ ...input, mode: 'continue', targetUid: 'codex:one' })
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true, startExecution: true })).rejects.toThrow('不会抢占')
  expect(work.submit).not.toHaveBeenCalled()
})
it('rejects changed targets, permission changes and stopped prior work', async () => {
  const { managed, input, card, store, bind, work } = fixture()
  const proposal = managed.prepare({ ...input, mode: 'continue', targetUid: 'codex:one' })
  card.fingerprint = 'b'.repeat(64)
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true, startExecution: true })).rejects.toThrow('已变化')
  bind({ kind: 'engine-ticket', ticketId: 'old', workId: 'old', executor: 'codex', permission: 'workspace-write' })
  expect(() => managed.prepare({ ...input, mode: 'continue', targetUid: 'engine:old', permission: 'read-only' })).toThrow('权限固定')
  expect(managed.prepare({ ...input, mode: 'continue', targetUid: 'engine:old' })).toMatchObject({ permission: 'workspace-write', permissionFixed: true })
  bind({ kind: 'engine-ticket', ticketId: 'old', workId: 'old', executor: 'codex', permission: 'read-only' })
  vi.spyOn(store.tickets, 'get').mockReturnValue({ ended: { outcome: 'stopped' } } as never)
  expect(() => managed.prepare({ ...input, mode: 'continue', targetUid: 'engine:old' })).toThrow('用户停止')
  expect(work.submit).not.toHaveBeenCalled()
})

it('keeps write proposals distinct and requires explicit confirmation authority before starting or submitting', async () => {
  const { managed, input, work, start } = fixture()
  const readonly = managed.prepare(input), writable = managed.prepare({ ...input, permission: 'workspace-write' })
  expect(writable.id).not.toBe(readonly.id)
  expect(work.submit).not.toHaveBeenCalled()
  const confirmation = { id: writable.id, token: writable.token, confirmed: true, startExecution: true }
  await expect(managed.confirm(confirmation)).rejects.toThrow('explicit authorization')
  expect(start).not.toHaveBeenCalled(); expect(work.submit).not.toHaveBeenCalled()
  const authorized = { ...confirmation, writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }
  await managed.confirm(authorized)
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }))
  expect(work.submit).toHaveBeenCalledWith(expect.objectContaining({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }))
  await managed.confirm(authorized)
  expect(work.submit).toHaveBeenCalledTimes(1)
  await expect(managed.confirm({ ...authorized, permission: 'read-only' })).rejects.toThrow('权限固定')
})

it('allows the user to select write access on a new draft but never changes an existing work binding', async () => {
  const { managed, input, work, bind } = fixture(), draft = managed.prepare(input)
  await managed.confirm({ id: draft.id, token: draft.token, confirmed: true, startExecution: true,
    permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })
  expect(work.submit).toHaveBeenCalledWith(expect.objectContaining({ workId: draft.workId, permission: 'workspace-write' }))
  bind({ kind: 'engine-ticket', ticketId: 'old', workId: 'old', executor: 'codex', permission: 'read-only' })
  const continuation = managed.prepare({ ...input, mode: 'continue', targetUid: 'engine:old' })
  await expect(managed.confirm({ id: continuation.id, token: continuation.token, confirmed: true,
    permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' })).rejects.toThrow('权限固定')
  expect(work.submit).toHaveBeenCalledTimes(1)
})

it('applies standing write authorization only while configured and respects explicit read-only', async () => {
  const { managed, input, options, work } = fixture()
  options.defaultPermission = 'workspace-write'; options.paused = false
  const proposal = managed.prepare(input)
  expect(proposal.permission).toBe('workspace-write')
  options.defaultPermission = 'read-only'
  await expect(managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true })).rejects.toThrow('explicit authorization')
  options.defaultPermission = 'workspace-write'
  await managed.confirm({ id: proposal.id, token: proposal.token, confirmed: true })
  expect(work.submit).toHaveBeenCalledWith(expect.objectContaining({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }))
  expect(managed.prepare({ ...input, permission: 'read-only', instruction: 'read only' }).permission).toBe('read-only')
})
