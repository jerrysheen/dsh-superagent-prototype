/** Cloud source dates, complete metadata inventories and non-executable reference identity. */
import { expect, it, vi } from 'vitest'
import { ChatgptSource, ChatgptSourceConfig, type ChatgptRow } from '../src/app/chatgpt-source.ts'

const row = (id: string, at: string): ChatgptRow => ({ id, title: '云端讨论', updatedAt: Date.parse(at) / 1000, projectId: null, status: 'idle' })
const a = row('6aeaf13e-ccac-83ec-85d6-c28959106f76', '2026-04-01T00:00:00+08:00')
const b = row('6ae86870-a1dc-83ec-be4b-709d2aaaa6a3', '2026-03-31T23:59:59+08:00')
function store() {
  let state: unknown
  return { get: vi.fn(() => state), set: vi.fn((_key: unknown, value: unknown) => { state = value }) } as never
}
it('defaults to April 1 Shanghai time, paginates and filters without importing pre-boundary data', async () => {
  const read = vi.fn(async (cursor?: string) => cursor ? { threads: [b] } : { threads: [a], nextCursor: 'p2' })
  const source = new ChatgptSource(store(), { read, close: vi.fn() })
  await source.sync()
  expect(read.mock.calls).toEqual([[undefined], ['p2']])
  expect(source.view()).toMatchObject({ since: '2026-04-01', count: 1, timeBasis: 'updatedAt', timezone: 'Asia/Shanghai', error: '' })
  expect(source.list().threads).toEqual([a])
  expect(source.reference('chatgpt:' + a.id)).toMatchObject({ provider: 'chatgpt', scope: 'cloud', workspace: '', summary: '' })
  expect(() => source.reference('codex:' + a.id)).toThrow()
})
it('preserves the prior complete inventory on a failed or looping pagination pass', async () => {
  const read = vi.fn(async (_cursor?: string): Promise<{ threads: ChatgptRow[]; nextCursor?: string }> => ({ threads: [a] }))
  const source = new ChatgptSource(store(), { read, close: vi.fn() })
  await source.sync()
  read.mockImplementation(async () => ({ threads: [], nextCursor: 'repeat' }))
  await source.sync()
  expect(source.list().threads).toEqual([a])
  expect(source.view().error).toContain('游标重复')
  read.mockRejectedValue(new Error('Unavailable'))
  await source.sync()
  expect(source.list().threads).toEqual([a])
})
it('persists the configured boundary and rejects out-of-range references immediately', async () => {
  const data = store(), source = new ChatgptSource(data, { read: async () => ({ threads: [a] }), close: vi.fn() })
  await source.sync()
  source.configure({ enabled: true, since: '2026-05-01' })
  expect(source.list().total).toBe(0)
  expect(() => source.reference('chatgpt:' + a.id)).toThrow(/日期范围/)
  await source.sync()
  expect(new ChatgptSource(data).view().since).toBe('2026-05-01')
  expect(ChatgptSourceConfig.safeParse({ enabled: true, since: '2026-02-30' }).success).toBe(false)
})
it('disabling during an in-flight sync prevents the old result from replacing current configuration', async () => {
  const pending = Promise.withResolvers<{ threads: ChatgptRow[] }>()
  const source = new ChatgptSource(store(), { read: () => pending.promise, close: vi.fn() })
  const sync = source.sync()
  source.configure({ enabled: false, since: '2026-04-01' })
  pending.resolve({ threads: [a] }); await sync
  expect(source.view()).toMatchObject({ enabled: false, count: 0 })
  await source.stop()
})

it('checks only the recent page, merges by real ID and retains older entries on failure', async () => {
  const read = vi.fn(async (_cursor?: string): Promise<{ threads: ChatgptRow[]; nextCursor?: string }> => ({ threads: [a] }))
  const source = new ChatgptSource(store(), { read, close: vi.fn() })
  await source.sync()
  const changed = { ...a, title: 'Updated', status: 'running' }
  const newer = { ...a, id: '11111111-1111-4111-8111-111111111111', updatedAt: a.updatedAt + 1 }
  read.mockResolvedValue({ threads: [changed, newer], nextCursor: 'do-not-fetch' })
  read.mockClear()
  await source.check()
  expect(read).toHaveBeenCalledTimes(1)
  expect(source.list().threads).toEqual([newer, changed])
  read.mockRejectedValue(Error('offline'))
  await source.check()
  expect(source.list().threads).toEqual([newer, changed])
  read.mockClear()
  await source.check()
  expect(read).not.toHaveBeenCalled()
})
