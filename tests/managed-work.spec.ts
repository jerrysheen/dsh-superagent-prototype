import { mkdtempSync, rmSync } from 'node:fs'
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
  const options: { enabled: boolean; paused: boolean; workspaces: string[]; defaultPermission?: 'read-only' | 'workspace-write' } = { enabled: true, paused: true, workspaces: ['F:\\Project'] }
  const card = { uid: 'codex:one', threadId: 'one', workspace: 'f:\\project', fingerprint: 'a'.repeat(64), title: 'Original work', archived: false }
  let binding: any = { kind: 'native-session', threadId: '01a1a0f6-353d-7581-b6dd-077563be0280' }
  const targets = { card: vi.fn(() => card), binding: vi.fn(() => binding) }
  const receipts = new Map<string, any>()
  const work = { result: vi.fn((id: string) => { if (!receipts.has(id)) throw Error('Unknown event'); return receipts.get(id) }),
    submit: vi.fn((request: any) => { receipts.set(request.eventId, { triggerId: 'local-work:' + request.eventId, tickets: [], nativeExecutions: [] }) }) }
  const activity = { state: 'idle', stale: false }
  const start = vi.fn(async () => { options.paused = false })
  const managed = new ManagedWork({ store, targets: targets as never, work: work as never, activities: { get: vi.fn(async () => activity) } as never, options: () => options, start })
  const input = { mode: 'new', workspace: 'F:\\Project', instruction: '只读检查原始问题', transport: 'app-server' }
  return { managed, store, input, options, targets, card, work, activity, start, bind: (value: unknown) => { binding = value } }
}
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
  await expect(managed.confirm({ id: next.id, token: next.token, confirmed: true, startExecution: true })).rejects.toThrow('已撤销')
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
