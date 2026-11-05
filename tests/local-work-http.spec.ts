import { expect, it, vi } from 'vitest'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

it('routes new work to Engine adapters, disables legacy task mutations, and enforces same-origin', async () => {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  const hub = { snapshot: () => ({ sessions: [], tasks: [] }), submitRouted: vi.fn(), receipt: vi.fn(), clearDemo: vi.fn() }
  const work = { submit: vi.fn(() => ({ triggerId: 'local-work:evt1', tickets: [] })), result: vi.fn(() => ({ triggerId: 'local-work:evt1' })) }
  registerSessionHub(ctx as never, hub as never, undefined, undefined, work as never)
  async function call(method: string, path: string, origin?: string) {
    let status = 0, body = ''
    await handler({ method, url: '/session-hub/api/' + path, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', origin },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"eventId":"evt1"}') } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } })
    return { status, body: JSON.parse(body) }
  }
  expect((await call('POST', 'work')).status).toBe(200)
  expect(work.submit).toHaveBeenCalledOnce()
  expect((await call('GET', 'work/evt1')).body.triggerId).toBe('local-work:evt1')
  expect((await call('POST', 'work', 'https://bad.example')).status).toBe(403)
  for (const path of ['tasks', 'tasks/old/receipts', 'clear-demo']) expect((await call('POST', path)).status).toBe(409)
  expect(hub.submitRouted).not.toHaveBeenCalled()
  expect(hub.receipt).not.toHaveBeenCalled()
  expect(hub.clearDemo).not.toHaveBeenCalled()
})
