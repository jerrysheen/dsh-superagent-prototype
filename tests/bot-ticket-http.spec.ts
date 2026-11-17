import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/app/store.ts'
import { SessionHub } from '../src/app/session-hub.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

let dispose = () => {}
afterEach(() => dispose())
it('routes only guarded GET requests to the read-only Bot Ticket projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-ticket-http-'))
  const store = new Store(join(dir, 'state.sqlite'))
  dispose = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  const view = {
    list: vi.fn(() => ({ readOnly: true, total: 0, items: [] })),
    detail: vi.fn((input: { uid: string }) => input.uid === 'engine:known' ? { uid: input.uid, state: 'working' } : undefined),
    waitForChange: vi.fn(async () => 7),
  }
  let handler: (req: any, res: any) => Promise<void> = async () => {}
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082,
    register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } } as never,
  new SessionHub(store), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, view as never)

  const call = async (method: string, path: string, extra: Record<string, string> = {}) => {
    let status = 0, response = ''
    await handler({ method, url: '/session-hub/api' + path, headers: {
      host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...extra,
    }, async *[Symbol.asyncIterator]() {} }, {
      writeHead: (code: number) => { status = code }, end: (body: string) => { response = body }, once: () => {},
    })
    return { status, body: JSON.parse(response) }
  }

  const list = await call('GET', '/bot/tickets?state=active&limit=2')
  expect(list).toMatchObject({ status: 200, body: { readOnly: true, total: 0 } })
  expect(view.list).toHaveBeenCalledWith({ query: '', state: 'active', limit: 2 })
  expect((await call('GET', '/bot/ticket?uid=engine%3Aknown'))).toMatchObject({
    status: 200, body: { uid: 'engine:known', state: 'working' },
  })
  expect((await call('GET', '/bot/ticket?uid=engine%3Amissing')).status).toBe(404)
  expect(await call('GET', '/bot/ticket-changes?after=6')).toMatchObject({ status: 200, body: { revision: 7 } })
  expect(view.waitForChange).toHaveBeenCalledWith(6, expect.any(AbortSignal))
  expect((await call('GET', '/bot/tickets?unexpected=1')).status).toBe(400)
  expect((await call('POST', '/bot/tickets')).status).toBe(404)
  expect((await call('GET', '/bot/tickets', { origin: 'https://untrusted.example' })).status).toBe(403)
  expect(view.list).toHaveBeenCalledTimes(1)
  expect(store.tickets.list()).toHaveLength(0)
})
