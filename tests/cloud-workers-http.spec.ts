/** Registration and explicit cloud dispatch share the same-origin guard; metadata reads never send. */
import { expect, it, vi } from 'vitest'
import { CloudWorkers } from '../src/app/cloud-workers.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

it('registers a worker, prepares and confirms once, rejecting unguarded requests and parameter overrides', async () => {
  let state: unknown
  const send = vi.fn(async (_thread: string, _prompt: string, id: string) => ({ receiptId: id }))
  const workers = new CloudWorkers({ store: { get: () => state, set: (_key: unknown, value: unknown) => { state = value } } as never,
    source: { reference: () => ({}) } as never, transport: { send } })
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } } as never,
    {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workers)
  const call = async (method: string, path: string, data?: unknown, guarded = true) => {
    let status = 0, body = ''
    await handler({ method, url: '/session-hub/api/workers/cloud' + path,
      headers: { host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}) },
      async *[Symbol.asyncIterator]() { if (data) yield Buffer.from(JSON.stringify(data)) } }, {
      writeHead: (value: number) => { status = value }, end: (value: string) => { body = value },
    })
    return { status, body: JSON.parse(body) }
  }
  const threadId = '6aeaf13e-ccac-83ec-85d6-c28959106f76'
  expect((await call('GET', '', undefined, false)).status).toBe(403)
  const registered = await call('POST', '', { threadId, name: '通用问答', purpose: 'qa' })
  expect(registered.status).toBe(200)
  const prepared = await call('POST', '/prepare', { workerId: registered.body.id, question: '解释概念' })
  expect(prepared.body.state).toBe('prepared')
  expect(send).not.toHaveBeenCalled()
  expect((await call('POST', '/messages/' + prepared.body.id + '/send', { confirmed: true, thinking: 'xhigh' })).status).toBe(400)
  expect((await call('POST', '/messages/' + prepared.body.id + '/send', { confirmed: true })).body.state).toBe('submitted')
  await call('POST', '/messages/' + prepared.body.id + '/send', { confirmed: true })
  expect(send).toHaveBeenCalledExactlyOnceWith(threadId, '解释概念', prepared.body.id)
  expect((await call('GET', '')).body.receipts[0].state).toBe('submitted')
})
