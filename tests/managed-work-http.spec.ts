import { afterEach, expect, it, vi } from 'vitest'
import { registerSessionHub } from '../src/app/session-hub-http.ts'
afterEach(() => vi.unstubAllEnvs())

it('keeps proposals separate from confirmation and requires same-origin management requests', async () => {
  vi.stubEnv('DSH_BOT_BRIDGE_TOKEN', 'fixture-management-credential')
  let handler: any
  const managed = { list: vi.fn(() => ({ options: {}, proposals: [], works: [] })), prepare: vi.fn(() => ({ state: 'draft' })),
    confirm: vi.fn(async () => ({ state: 'submitted' })), cancel: vi.fn() }
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { handler = route.handler; return () => {} } } } as never,
    {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, managed as never)
  async function call(method: string, path: string, guarded = true, token?: string) {
    let status = 0
    await handler({ method, url: '/session-hub/api/managed-work' + path, headers: { host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}),
      ...(token ? { 'x-superagent-bot-token': token } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, { writeHead: (code: number) => { status = code }, end: () => {} })
    return status
  }
  try {
    expect(await call('GET', '')).toBe(200)
    expect(await call('POST', '/prepare')).toBe(200)
    expect(managed.confirm).not.toHaveBeenCalled()
    expect(await call('POST', '/confirm', false)).toBe(403)
    expect(managed.confirm).not.toHaveBeenCalled()
    expect(await call('POST', '/confirm')).toBe(403)
    expect(await call('POST', '/confirm', true, 'incorrect-credential')).toBe(403)
    expect(await call('POST', '/cancel')).toBe(403)
    expect(managed.confirm).not.toHaveBeenCalled()
    expect(await call('POST', '/confirm', true, 'fixture-management-credential')).toBe(200)
    expect(managed.confirm).toHaveBeenCalledTimes(1)
  } finally { dispose() }
})

it('serves compact options, pending drafts and exact draft reads without loading the full ledger', async () => {
  let handler: any
  const id = 'a44d1ce0-2092-413e-9365-cdbfa766cc21'
  const managed = {
    list: vi.fn(() => { throw Error('full ledger must not be read') }),
    options: vi.fn(() => ({ enabled: true })),
    summaries: vi.fn(() => [{ id, state: 'draft' }]),
    draft: vi.fn((draftId: string, token = false) => draftId === id
      ? { id, state: 'draft', ...(token ? { token: 'fixture-proposal-token' } : {}) } : undefined),
  }
  vi.stubEnv('DSH_BOT_BRIDGE_TOKEN', 'fixture-management-credential')
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082,
    register: (route: any) => { handler = route.handler; return () => {} } } } as never,
  {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, managed as never)
  const call = async (path: string, token?: string) => {
    let status = 0, value: any
    await handler({ method: 'GET', url: '/session-hub/api' + path, headers: {
      host: '127.0.0.1:3082', 'x-orchestrator-request': '1',
      ...(token ? { 'x-superagent-bot-token': token } : {}),
    } }, { writeHead: (code: number) => { status = code }, end: (body: string) => { value = JSON.parse(body) } })
    return { status, value }
  }
  try {
    expect((await call('/managed-work/options')).value).toEqual({ enabled: true })
    expect((await call('/managed-work/drafts?pending=1')).value.proposals).toHaveLength(1)
    expect(managed.summaries).toHaveBeenCalledWith(true)
    const detail = await call('/managed-work/draft?id=' + id)
    expect(detail.status).toBe(200)
    expect(detail.value.proposal).not.toHaveProperty('token')
    expect((await call('/bot/draft?id=' + id)).status).toBe(403)
    expect((await call('/bot/draft?id=' + id, 'fixture-management-credential')).value.proposal)
      .toHaveProperty('token', 'fixture-proposal-token')
    expect((await call('/managed-work/draft?id=invalid')).status).toBe(400)
    expect(managed.list).not.toHaveBeenCalled()
  } finally { dispose() }
})
