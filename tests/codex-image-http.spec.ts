import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/app/store.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { SessionHub } from '../src/app/session-hub.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'
const wire = vi.hoisted(() => ({ requests: [] as any[] }))
vi.mock('../src/executor/codex-rpc.ts', () => ({ CodexRpc: class {
  initialize = async () => {}; close = async () => {}
  request = async (method: string, params: any) => { wire.requests.push({ method, params }); return { queuedSubmission: { id: '01a1a0f6-353d-7581-b6dd-077563be0285', clientUserMessageId: params.clientUserMessageId, input: params.input.map((part: any) => part.type === 'localImage' ? { type: 'image', url: 'data:image/png;base64,fake' } : part) } } }
} }))
vi.mock('../src/app/codex-desktop-relay.ts', () => ({ continueDesktopCodex: async (question: any, deps: any) => {
  const delivery = await deps.queue(question.threadId, question.question); deps.onQueued?.(delivery)
  return { threadId: question.threadId, turnId: 'reply', status: 'completed', text: 'reply', ...delivery }
} }))
it('uploads a scoped image and enqueues native image input without resume; rejects another session and deduplicates', async () => {
  wire.requests = []; vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', '\\\\.\\pipe\\fake-observer'); vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', '01a1a0f6-353d-7581-b6dd-077563be0280')
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-http-')), store = new Store(join(directory, 'store.sqlite'))
  const id = '01a1a0f6-353d-7581-b6dd-077563be0280', other = '01a1a0f6-353d-7581-b6dd-077563be0281', catalog = new ContextCatalog(store)
  catalog.importMetadata({ entries: [id, other].map(nativeThreadId => ({ provider: 'codex', nativeThreadId, cwd: directory, title: 'test', sourceKind: 'vscode', archived: false, createdAt: 1, updatedAt: 2 })) })
  let handler: any
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (r: any) => { handler = r.handler; return () => {} } } } as never, new SessionHub(store), catalog)
  async function call(path: string, body: unknown) {
    let status = 0, value: any
    await handler({ method: 'POST', url: '/session-hub/api/' + path, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, { writeHead: (code: number) => { status = code }, end: (text: string) => { value = JSON.parse(text) } })
    return { status, value }
  }
  try {
    const uploaded = await call('codex/upload', { threadId: id, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' })
    expect(uploaded.status).toBe(200)
    const body = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0283', threadId: other, question: 'look', confirmed: true, images: [uploaded.value.id] }
    expect((await call('codex/ask', body)).status).toBe(400); expect(wire.requests).toHaveLength(0)
    const request = { ...body, threadId: id, requestId: '01a1a0f6-353d-7581-b6dd-077563be0284' }
    const sent = await call('codex/ask', request); expect(sent.status).toBe(200)
    expect(sent.value.transport).toBe('native_user_queue')
    await call('codex/ask', request)
    expect(wire.requests).toHaveLength(1)
    expect(wire.requests[0]).toMatchObject({ method: 'thread/queue/add', params: { threadId: id, input: [{ type: 'text', text: 'look' }, { type: 'localImage' }] } })
  } finally {
    dispose(); store.close(); vi.unstubAllEnvs()
    for (const request of wire.requests) for (const part of request.params.input) if (part.type === 'localImage') { if (!resolve(part.path).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe upload cleanup'); await unlink(part.path) }
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true })
  }
})

it('accepts a direct text question as native user input without a desktop agent sender and returns exact request identity', async () => {
  wire.requests = []; vi.stubEnv('DSH_ACTIVITY_PIPE_PATH', undefined); vi.stubEnv('DSH_ACTIVITY_CALLER_THREAD_ID', undefined)
  const directory = await mkdtemp(join(tmpdir(), 'codex-user-http-')), store = new Store(join(directory, 'store.sqlite'))
  const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280', catalog = new ContextCatalog(store)
  catalog.importMetadata({ entries: [{ provider: 'codex', nativeThreadId: threadId, cwd: directory, title: 'selected',
    sourceKind: 'vscode', archived: false, createdAt: 1, updatedAt: 2 }] })
  let handler: any
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082,
    register: (route: any) => { handler = route.handler; return () => {} } } } as never, new SessionHub(store), catalog)
  async function call(path: string, body?: unknown, guarded = true) {
    let status = 0, value: any
    await handler({ method: body ? 'POST' : 'GET', url: '/session-hub/api/' + path,
      headers: { host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}) },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { value = JSON.parse(text) } })
    return { status, value }
  }
  const input = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0283', threadId, question: 'typed by the user', confirmed: true }
  try {
    expect((await call('codex/capabilities')).value).toMatchObject({ enabled: true, transport: 'native_user_queue' })
    expect((await call('codex/submit', input, false)).status).toBe(403)
    expect(wire.requests).toHaveLength(0)
    expect(await call('codex/submit', input)).toEqual({ status: 202,
      value: { requestId: input.requestId, threadId, status: 'pending' } })
    await vi.waitFor(() => expect(wire.requests).toHaveLength(1))
    await call('codex/submit', input)
    expect(wire.requests.map(request => request.method)).toEqual(['thread/queue/add'])
    expect(wire.requests[0].params).toEqual({ threadId, clientUserMessageId: input.requestId,
      input: [{ type: 'text', text: input.question, text_elements: [] }] })
    expect((await call('codex/requests/' + input.requestId)).value).toMatchObject({
      delivery: { clientUserMessageId: input.requestId, transport: 'native_user_queue' },
    })
    expect((await call('codex/submit', { ...input, question: 'changed' })).status).toBe(400)
    expect((await call('codex/submit', { ...input, threadId: '01a1a0f6-353d-7581-b6dd-077563be0289' })).status).toBe(400)
    expect(wire.requests).toHaveLength(1)
    expect(store.tickets.list()).toHaveLength(0)
  } finally {
    dispose(); store.close(); vi.unstubAllEnvs()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true })
  }
})
