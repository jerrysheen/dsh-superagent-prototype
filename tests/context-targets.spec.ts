import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/app/store.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
const ids = ['01a1a0f6-353d-7581-b6dd-077563be0280', '01a1a178-e245-74b3-b1c5-ea74d36a3a65']
let directory: string, store: Store, catalog: ContextCatalog, targets: ContextTargets
const entry = (id: string, title: string, cwd = 'F:\\Github\\runtime-lens', sourceKind = 'vscode') => ({
  provider: 'codex', nativeThreadId: id, title, cwd, sourceKind, createdAt: 1, updatedAt: 2, archived: false,
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'target-cards-')); store = new Store(join(directory, 'state.sqlite'))
  catalog = new ContextCatalog(store); targets = new ContextTargets(catalog, store)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
it('groups Windows aliases by canonical directory, never by display name alone', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, 'WASM 内存膨胀'), entry(ids[1]!, '另一项工作', 'f:/github/RUNTIME-LENS/')] })
  const projects = targets.projects({ query: 'runtime-lens' })
  expect(projects).toHaveLength(1); expect(projects[0]?.sessionCount).toBe(2)
  expect(targets.projects({ query: 'runtime-lens' })[0]?.id).toBe(projects[0]?.id)
})
it('supports semantic query expansions and removes conversational stop words before ranking', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, '分析 WASM 代码内存膨胀'), entry(ids[1]!, '修复资源路径问题')] })
  const hits = targets.search({ query: '继续上次那个内存问题', expansions: ['代码内存膨胀'] })
  expect(hits[0]?.uid).toBe('codex:' + ids[0]); expect(hits.some(h => h.uid === 'codex:' + ids[1])).toBe(false)
})
it('filters internal sessions before the retrieval limit and resolves cards without histories', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, 'WASM memory', undefined, 'subAgentReview'), entry(ids[1]!, 'WASM memory')] })
  expect(targets.search({ query: 'WASM', limit: 1 })[0]?.uid).toBe('codex:' + ids[1])
  expect(targets.card('codex:' + ids[0])).toBeUndefined()
  expect(targets.card('codex:' + ids[1])?.title).toBe('WASM memory')
  expect(store.tickets.list()).toHaveLength(0)
})
it('keeps same-title sessions in separate Windows projects and explicitly marks native execution unbound', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, 'WASM memory'), entry(ids[1]!, 'WASM memory', 'F:\\Other\\runtime-lens')] })
  const projects = targets.projects({ query: 'runtime-lens' }); expect(projects).toHaveLength(2)
  expect(targets.search({ query: 'WASM', projectId: projects[0]!.id })).toHaveLength(1)
  expect(targets.binding('codex:' + ids[0])).toMatchObject({ kind: 'native-session', executable: true, executor: 'codex', threadId: ids[0] })
})
it('rejects unknown project IDs and never uses a caller supplied directory as an indexed target', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, 'WASM memory')] })
  expect(targets.search({ query: 'WASM', projectId: 'invented' })).toEqual([])
  expect(targets.binding('invented')).toBeUndefined()
})
it('syncs newly opened desktop sessions and removes deleted derivatives only from a complete inventory', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, 'old title')] })
  catalog.syncDesktop([{ id: ids[0]!, cwd: 'F:\\Github\\runtime-lens', title: 'new title', updatedAt: 4 }, { id: ids[1]!, cwd: 'F:\\Github\\runtime-lens', title: 'current session', updatedAt: 5 }])
  expect(catalog.threads({}).threads.map(row => row.title)).toEqual(['current session', 'new title'])
  expect(() => catalog.reconcile({ nativeThreadIds: [ids[1]], complete: false })).toThrow()
  expect(catalog.reconcile({ nativeThreadIds: [ids[1]], complete: true })).toMatchObject({ removed: 1 })
  expect(targets.card('codex:' + ids[0])).toBeUndefined()
})
