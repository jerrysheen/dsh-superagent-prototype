import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { SessionHub } from '../src/app/session-hub.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

const wire = vi.hoisted(() => ({ requests: [] as { method: string; params: any }[], listeners: [] as ((event: any) => void)[] }))
vi.mock('../src/executor/codex-rpc.ts', () => ({ CodexRpc: class {
  initialize = async () => {}; close = async () => {}
  subscribe = (listener: (event: any) => void) => { wire.listeners.push(listener) }
  request = async (method: string, params: any) => {
    wire.requests.push({ method, params })
    return method === 'thread/start' ? { thread: { id: '01a1a0f6-353d-7581-b6dd-077563be0281', cwd: params.cwd }, model: 'gpt-6.1-sol' } : { turn: { id: 'synthetic-turn' } }
  }
} }))

it('creates an image-only native turn, rejects changed request IDs and arbitrary paths, and releases uploads', async () => {
  wire.requests = []; wire.listeners = []
  const directory = await mkdtemp(join(tmpdir(), 'codex-create-http-')), store = new Store(join(directory, 'store.sqlite'))
  const catalog = new ContextCatalog(store), existing = '01a1a0f6-353d-7581-b6dd-077563be0280'
  catalog.importMetadata({ entries: [{ provider: 'codex', nativeThreadId: existing, cwd: directory, title: 'Synthetic project', sourceKind: 'appServer', archived: false, createdAt: 1, updatedAt: 2 }] })
  let handler: any
  const dispose = registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { handler = route.handler; return () => {} } } } as never,
    new SessionHub(store), catalog, undefined, undefined, undefined, { targets: new ContextTargets(catalog, store) } as never)
  async function call(body: unknown, guarded = true) {
    let status = 0, value: any
    await handler({ method: 'POST', url: '/session-hub/api/sidebar/create', headers: { host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, { writeHead: (code: number) => { status = code }, end: (text: string) => { value = JSON.parse(text) } })
    return { status, value }
  }
  const input = { requestId: '01a1a0f6-353d-7581-b6dd-077563be0282', target: 'codex', cwd: directory, text: '',
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='] }
  try {
    expect((await call(input, false)).status).toBe(403)
    expect((await call({ ...input, cwd: 'F:\\not-catalogued' })).status).toBe(400)
    expect((await call({ ...input, images: ['C:\\private.png'] })).status).toBe(400)
    expect(wire.requests).toHaveLength(0)
    const valid = { ...input, requestId: '01a1a0f6-353d-7581-b6dd-077563be0283' }
    expect(await call(valid)).toMatchObject({ status: 200, value: { status: 'accepted', model: 'gpt-6.1-sol' } })
    await call(valid)
    expect(wire.requests.map(request => request.method)).toEqual(['thread/start', 'turn/start'])
    expect(wire.requests[1]?.params.input).toEqual([{ type: 'localImage', path: expect.stringContaining('codex-clipboard-') }])
    expect((await call({ ...valid, text: 'changed' })).status).toBe(400)
    expect(store.tickets.list()).toHaveLength(0)
  } finally {
    for (const listener of wire.listeners) listener({ method: 'turn/completed', params: { threadId: '01a1a0f6-353d-7581-b6dd-077563be0281' } })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    dispose(); store.close()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    await rm(directory, { recursive: true, force: true })
  }
})
