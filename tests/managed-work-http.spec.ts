import { expect, it, vi } from 'vitest'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

it('keeps proposals separate from confirmation and requires same-origin management requests', async () => {
  let handler: any
  const managed = { list: vi.fn(() => ({ options: {}, proposals: [], works: [] })), prepare: vi.fn(() => ({ state: 'draft' })),
    confirm: vi.fn(async () => ({ state: 'submitted' })), cancel: vi.fn() }
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { handler = route.handler; return () => {} } } } as never,
    {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, managed as never)
  async function call(method: string, path: string, guarded = true) {
    let status = 0
    await handler({ method, url: '/session-hub/api/managed-work' + path, headers: { host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, { writeHead: (code: number) => { status = code }, end: () => {} })
    return status
  }
  try {
    expect(await call('GET', '')).toBe(200)
    expect(await call('POST', '/prepare')).toBe(200)
    expect(managed.confirm).not.toHaveBeenCalled()
    expect(await call('POST', '/confirm', false)).toBe(403)
    expect(managed.confirm).not.toHaveBeenCalled()
    expect(await call('POST', '/confirm')).toBe(200)
    expect(managed.confirm).toHaveBeenCalledTimes(1)
  } finally { dispose() }
})
