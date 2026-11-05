import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SessionHub } from '../src/app/session-hub.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { ChatgptSource } from '../src/app/chatgpt-source.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'
import type { RoutingInput, SessionRouting } from '../src/app/session-router.ts'

let directory: string, store: Store, hub: SessionHub, catalog: ContextCatalog
const id = '01a1a0f6-353d-7581-b6dd-077563be0280'
const example = { provider: 'codex', nativeThreadId: id, cwd: 'F:\\ElexGithub\\GIGNew\\client',
  sourceKind: 'vscode', title: 'GC Profiler 采集优化', archived: false, createdAt: 1760000000, updatedAt: 1760000020 }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'context-http-')); store = new Store(join(directory, 'state.sqlite'))
  hub = new SessionHub(store); catalog = new ContextCatalog(store) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('keeps cloud source dates, metadata listing and references independent of local execution bindings', async () => {
  const source = new ChatgptSource(store, { read: async () => ({ threads: [{ id, title: '云端讨论', updatedAt: Date.parse('2026-05-01T00:00:00Z') / 1000,
    projectId: null, status: 'idle' }] }), close: vi.fn() })
  await source.sync()
  const targets = new ContextTargets(catalog, store)
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } } as never,
    hub, catalog, undefined, undefined, undefined, { targets } as never, undefined, undefined, undefined, source)
  const call = async (method: string, path: string, data?: unknown) => {
    let status = 0, body = ''
    await handler({ method, url: '/session-hub/api/context/' + path, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() { if (data) yield Buffer.from(JSON.stringify(data)) } }, {
      writeHead: (code: number) => { status = code }, end: (value: string) => { body = value },
    })
    return { status, body: JSON.parse(body) }
  }
  expect(await call('GET', 'chatgpt-source')).toMatchObject({ status: 200, body: { since: '2026-04-01', count: 1 } })
  expect(await call('GET', 'references')).toMatchObject({ status: 200, body: { items: [{ uid: 'chatgpt:' + id, provider: 'chatgpt', scope: 'cloud', workspace: '' }] } })
  expect(await call('GET', 'reference?uid=' + encodeURIComponent('chatgpt:' + id))).toMatchObject({ status: 200, body: { reference: { provider: 'chatgpt' } } })
  expect(targets.binding('chatgpt:' + id)).toBeUndefined()
  expect(await call('PUT', 'chatgpt-source', { enabled: true, since: '2026-06-01' })).toMatchObject({ status: 200, body: { count: 0 } })
  await source.sync()
  expect((await call('GET', 'chatgpt-threads')).body.threads).toEqual([])
  expect(store.tickets.list()).toHaveLength(0)
  await source.stop()
})

it('lists and resolves metadata references under the same-origin guard without dispatching work', async () => {
  catalog.importMetadata({ entries: [example] })
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  const targets = new ContextTargets(catalog, store)
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => {
    handler = route.handler; return () => {}
  } } } as never, hub, catalog, undefined, undefined, undefined, { targets } as never)
  const call = async (path: string, guarded = true) => {
    let status = 0, body = ''
    await handler({ method: 'GET', url: '/session-hub/api/' + path, headers: { host: '127.0.0.1:3082',
      ...(guarded ? { 'x-orchestrator-request': '1' } : {}) } }, {
      writeHead: (code: number) => { status = code }, end: (value: string) => { body = value },
    })
    return { status, body: JSON.parse(body) }
  }
  expect(await call('context/references?query=Profiler')).toMatchObject({ status: 200, body: { total: 1,
    items: [{ uid: 'codex:' + id, title: example.title, provider: 'codex' }] } })
  expect(await call('context/reference?uid=' + encodeURIComponent('codex:' + id))).toMatchObject({ status: 200,
    body: { reference: { uid: 'codex:' + id, threadId: id } } })
  expect((await call('context/references', false)).status).toBe(403)
  expect((await call('context/reference?uid=unknown')).status).toBe(400)
  catalog.importMetadata({ entries: [{ ...example, archived: true }] })
  expect((await call('context/reference?uid=' + encodeURIComponent('codex:' + id))).status).toBe(400)
  expect(store.tickets.list()).toHaveLength(0)
  expect(hub.snapshot().tasks).toHaveLength(0)
})
it('previews a clicked file only for a known thread under the same-origin guard', async () => {
  writeFileSync(join(directory, 'guide.md'), '# Synthetic API fixture')
  catalog.importMetadata({ entries: [{ ...example, cwd: directory }] })
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } } as never, hub, catalog)
  const call = async (threadId: string, path: string, guarded = true) => {
    let status = 0, body = ''
    await handler({ method: 'GET', url: '/session-hub/api/codex/preview?' + new URLSearchParams({ threadId, path }), headers: {
      host: '127.0.0.1:3082', ...(guarded ? { 'x-orchestrator-request': '1' } : {}),
    } }, { writeHead: (code: number) => { status = code }, end: (value: string) => { body = value } })
    return { status, body: JSON.parse(body) }
  }
  expect(await call(id, 'guide.md')).toMatchObject({ status: 200, body: { text: '# Synthetic API fixture', markdown: true } })
  expect((await call(id, 'guide.md', false)).status).toBe(403)
  expect((await call('01a1a0f6-353d-7581-b6dd-077563be0299', 'guide.md')).status).toBe(404)
  expect((await call(id, '../outside.md')).status).toBe(400)
  expect(hub.snapshot().tasks).toEqual([])
})
it('imports Codex session metadata into the catalog, not the SessionHub task board', async () => {
  const recommend = vi.fn(async (input: RoutingInput) => ({
    action: 'needs_confirmation' as const, targetSessionUid: null, reason: '证据不足',
    model: null, consideredUids: input.cards.map(card => card.uid), inputHash: 'test',
    decidedAt: '2026-11-03T00:00:00.000Z',
  }))
  const router: SessionRouting = { recommend }
  type Handler = (request: unknown, response: unknown) => Promise<void>
  let handler: Handler = async () => {}
  const context = { webServer: { host: '127.0.0.1', port: 3082,
    register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerSessionHub(context as never, hub, catalog, router)
  const call = async (method: string, path: string, value?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, body = '', contentType = ''
    const request = { method, url: '/session-hub/api/' + path, headers: {
      host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers,
    }, async *[Symbol.asyncIterator]() { if (value !== undefined) yield Buffer.from(JSON.stringify(value)) } }
    await handler(request, { writeHead: (code: number, headers: Record<string, string>) => { status = code; contentType = headers['content-type'] ?? '' },
      end: (result: string) => { body = result } })
    return { status, contentType, body: JSON.parse(body) }
  }
  const emptyStats = await call('GET', 'context/stats')
  expect((await call('GET', 'knowledge')).body).toMatchObject({ status: 'idle', nodes: [], edges: [] })
  expect((await call('POST', 'knowledge', { confirmed: false })).status).toBe(400)
  expect((await call('POST', 'knowledge', { confirmed: true }, { origin: 'https://untrusted.local' })).status).toBe(403)
  expect(emptyStats.status).toBe(200)
  expect(emptyStats.contentType).toBe('application/json; charset=utf-8')
  expect(emptyStats.body.total).toBe(0)
  expect((await call('POST', 'context/import', { entries: [example] })).body).toMatchObject({ added: 1, total: 1 })
  expect((await call('GET', 'context/stats')).body).toMatchObject({ total: 1, curated: 0, projects: { GIGNew: 1 } })
  await call('POST', 'context/import', { entries: [
    { ...example, nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0281', cwd: 'F:\\Projects\\Assets', title: 'Assets' },
    { ...example, nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0282', cwd: 'F:\\Projects\\assets', title: 'assets' },
  ] })
  const stats = await call('GET', 'context/stats')
  expect(stats.status).toBe(200)
  expect(stats.contentType).toBe('application/json; charset=utf-8')
  expect(stats.body).toMatchObject({ total: 3, projects: { Assets: 1, assets: 1 } })
  await call('POST', 'context/import', { entries: [
    { ...example, nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0283', title: 'Unrelated child', sourceKind: 'subAgentReview' },
    { ...example, nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0284', title: 'Unrelated archive', archived: true },
  ] })
  const threads = await call('GET', 'context/threads?limit=2')
  expect(threads.status).toBe(200)
  expect(threads.body).toMatchObject({ total: 3, nextOffset: 2 })
  expect(threads.body.threads).toHaveLength(2)
  expect(Object.keys(threads.body.threads[0]).sort()).toEqual(['cwd', 'projectName', 'provider', 'threadId', 'title', 'updatedAt'])
  expect((await call('GET', 'context/threads?offset=2')).body.threads).toHaveLength(1)
  expect((await call('GET', 'context/threads?limit=101')).status).toBe(400)
  expect((await call('GET', 'codex/capabilities')).body.enabled).toBe(false)
  expect((await call('POST', 'codex/ask', { requestId: id, threadId: id, question: 'No send', confirmed: true })).status).toBe(400)
  const match = await call('POST', 'context/search', { query: 'GC Profiler', limit: 10 })
  expect(match.status).toBe(200)
  expect(match.body.matches[0].nativeThreadId).toBe(id)
  const route = await call('POST', 'context/route', { query: 'GC Profiler' })
  expect(route.status).toBe(200)
  expect(route.body.decision.action).toBe('needs_confirmation')
  expect(recommend).toHaveBeenCalledOnce()
  expect(recommend.mock.calls[0]?.[0]?.cards).toHaveLength(1)
  expect(hub.snapshot().tasks).toEqual([])
  expect(hub.snapshot().sessions).toEqual([])
  expect(store.tickets.list()).toEqual([])
  const organization = { nativeThreadId: id, title: '本地整理标题', category: '性能剖析与内存',
    summary: '讨论 GC Profiler 调用栈与内存归因。', kind: 'discussion', coverage: 'recent-turns',
    evidence: [{ threadId: id }], reviewedAt: '2026-11-04T08:00:00.000Z' }
  expect((await call('POST', 'context/organization', { entries: [organization] }, { origin: 'https://untrusted.local' })).status).toBe(403)
  expect((await call('POST', 'context/organization', { entries: [{ ...organization, messages: ['PRIVATE'] }] })).status).toBe(400)
  expect((await call('POST', 'context/organization', { entries: [organization] })).body).toEqual({ organized: 1 })
  expect((await call('GET', 'context/stats')).body.organized).toBe(1)
  expect((await call('POST', 'context/import', { entries: [{ ...example, messages: ['PRIVATE'] }] })).status).toBe(400)
  expect((await call('POST', 'context/search', { query: 'GC' }, { origin: 'https://untrusted.local' })).status).toBe(403)
  const frozen = await call('POST', 'context/candidates', { query: 'GC Profiler' })
  expect(frozen.status).toBe(200)
  expect(frozen.body.metadata.map((card: { uid: string }) => card.uid)).toEqual(frozen.body.preview.map((card: { uid: string }) => card.uid))
  expect((await call('POST', 'context/evaluate', { query: '继续 GC Profiler', cards: frozen.body.metadata })).status).toBe(200)
  expect(recommend.mock.calls.at(-1)?.[0]?.purpose).toBe('lookup')
  expect((await call('POST', 'context/evaluate', { query: '新建一条独立任务', cards: frozen.body.metadata, purpose: 'task' })).status).toBe(200)
  expect(recommend.mock.calls.at(-1)?.[0]?.purpose).toBe('task')
  expect((await call('POST', 'context/evaluate', { query: 'GC', cards: frozen.body.metadata }, { origin: 'https://untrusted.local' })).status).toBe(403)
  expect((await call('POST', 'context/evaluate', { query: 'GC', cards: [], tasks: ['forbidden'] })).status).toBe(400)
  expect(hub.snapshot().tasks).toEqual([])
  expect(store.tickets.list()).toEqual([])
})
