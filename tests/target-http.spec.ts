import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { TargetResolver } from '../src/app/target-resolver.ts'
import { SessionHub } from '../src/app/session-hub.ts'
import { Store } from '../src/app/store.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'
let cleanup = () => {}
afterEach(() => cleanup())
it('exposes guarded read-only cards, resolution and current target selection without Engine submission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'target-http-')), store = new Store(join(directory, 'state.sqlite'))
  cleanup = () => { store.close(); rmSync(directory, { recursive: true, force: true }) }
  const catalog = new ContextCatalog(store)
  catalog.importMetadata({ entries: [{ provider: 'codex', nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0280',
    cwd: 'F:\\Example', title: 'WASM 内存', sourceKind: 'vscode', archived: false, createdAt: 1, updatedAt: 2 }] })
  const targets = new ContextTargets(catalog, store)
  const resolver = new TargetResolver(targets, { model: () => null, llm: { async *stream() { throw Error('No model call') } },
    timeoutMs: () => 1000, lifetime: new AbortController().signal })
  const resolve = vi.spyOn(resolver, 'resolve').mockResolvedValue({ action: 'needs_confirmation', intent: 'needs_confirmation',
    candidates: [], projects: [], target: null, reason: '请指定主题', toolTrace: [], model: null })
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  registerSessionHub({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } } as never,
    new SessionHub(store), catalog, undefined, undefined, undefined, resolver)
  async function call(path: string, body: unknown, origin?: string) {
    let status = 0, value = ''
    await handler({ method: 'POST', url: '/session-hub/api/context/' + path,
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { value = text } })
    return { status, value: JSON.parse(value) }
  }
  expect((await call('resolve', { query: '上次那个' })).status).toBe(200)
  expect(resolve).toHaveBeenCalledOnce()
  expect((await call('resolve', { query: '秘密', messages: [] })).status).toBe(400)
  expect((await call('resolve', { query: '上次那个' }, 'https://outside.example')).status).toBe(403)
  expect((await call('projects', { query: 'Example' })).value.projects).toHaveLength(1)
  const card = targets.cards()[0]!
  expect((await call('select', { uid: card.uid, fingerprint: card.fingerprint })).value).toMatchObject({ execution: 'not_submitted', target: { card: { uid: card.uid } } })
  expect((await call('select', { uid: card.uid, fingerprint: '0'.repeat(64) })).status).toBe(400)
  expect(store.tickets.list()).toHaveLength(0)
})
