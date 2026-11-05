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
  request = async (method: string, params: any) => { wire.requests.push({ method, params }); return { queuedSubmission: { id: '01a1a0f6-353d-7581-b6dd-077563be0285', input: params.input.map((part: any) => part.type === 'localImage' ? { type: 'image', url: 'data:image/png;base64,fake' } : part) } } }
} }))
vi.mock('../src/app/codex-desktop-relay.ts', () => ({ continueDesktopCodex: async (question: any, deps: any) => ({ threadId: question.threadId, turnId: 'reply', status: 'completed', text: 'reply', ...await deps.queue(question.threadId, question.question) }) }))
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
    expect(sent.value.transport).toBe('native_image_queue')
    await call('codex/ask', request)
    expect(wire.requests).toHaveLength(1)
    expect(wire.requests[0]).toMatchObject({ method: 'thread/queue/add', params: { threadId: id, input: [{ type: 'text', text: 'look' }, { type: 'localImage' }] } })
  } finally {
    dispose(); store.close(); vi.unstubAllEnvs()
    for (const request of wire.requests) for (const part of request.params.input) if (part.type === 'localImage') { if (!resolve(part.path).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe upload cleanup'); await unlink(part.path) }
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true })
  }
})
