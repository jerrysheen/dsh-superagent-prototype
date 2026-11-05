import { beforeEach, afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { ContextCatalog, terms } from '../src/app/context-catalog.ts'

const gig = 'F:\\ElexGithub\\GIGNew\\client'
const other = 'F:\\Github\\DSHSuperAgent'
const ids = ['01a1a0f6-353d-7581-b6dd-077563be0280','01a1a178-e245-74b3-b1c5-ea74d36a3a65',
  '01a1a178-ffbc-7330-987e-48f16cc3d12a']
let root: string, store: Store, catalog: ContextCatalog
const entry = (nativeThreadId: string, cwd: string, title: string, archived = false) => ({
  provider: 'codex' as const, nativeThreadId, cwd, title, archived,
  sourceKind: 'vscode', createdAt: 1760000000, updatedAt: 1760000020,
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'context-catalog-'))
  store = new Store(join(root, 'state.sqlite'))
  catalog = new ContextCatalog(store)
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

it('keeps reviewed local organization through metadata sync without replacing native names', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '')] })
  const organization = { nativeThreadId: ids[0]!, title: 'NGUI 淡入淡出与子节点透明度', category: 'Unity 界面与动效',
    summary: '讨论 TweenAlpha 的子节点透明度传播及编辑器预览。', kind: 'discussion', coverage: 'recent-turns',
    evidence: [{ threadId: ids[0]! }], reviewedAt: '2026-11-04T08:00:00.000Z' }
  catalog.importOrganization({ entries: [organization] })
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '')] })
  expect(catalog.threads().threads[0]?.title).toBe(organization.title)
  expect(catalog.search({ query: '透明度传播' })[0]?.nativeThreadId).toBe(ids[0])
  expect(catalog.targetEntries()[0]?.summary).toBe(organization.summary)
  expect(catalog.stats()).toMatchObject({ organized: 1, titled: 1 })
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '原生自定义名称')] })
  expect(catalog.threads().threads[0]?.title).toBe('原生自定义名称')
  expect(catalog.organizations()[0]?.title).toBe(organization.title)
  expect(() => catalog.importOrganization({ entries: [{ ...organization, nativeThreadId: ids[1] }] })).toThrow()
  expect(() => catalog.importOrganization({ entries: [{ ...organization, evidence: [{ threadId: ids[1] }] }] })).toThrow()
  expect(catalog.organizations()).toHaveLength(1)
})

it('imports metadata only; keeps original Thread IDs without writing Tickets', () => {
  const records = [entry(ids[0]!, gig, 'GC Profiler 空栈分析'), entry(ids[1]!, gig, 'WASM 内存编译'), entry(ids[2]!, other, 'GC Profiler 修复')]
  expect(catalog.importMetadata({ entries: records })).toMatchObject({ added: 3, total: 3 })
  expect(catalog.stats()).toMatchObject({ total: 3, titled: 3, curated: 0, archived: 0 })
  expect(store.tickets.list()).toEqual([])
  const matches = catalog.search({ query: 'GC Profiler' })
  expect(matches).toHaveLength(2)
  expect(matches.map(x => x.nativeThreadId)).toContain(ids[0])
  expect(matches.map(x => x.nativeThreadId)).toContain(ids[2])
})
it('filters same-title threads by cwd, not by display name', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, 'WASM memory'), entry(ids[1]!, other, 'WASM memory')] })
  expect(catalog.search({ query: 'WASM', cwd: gig })).toHaveLength(1)
  expect(catalog.search({ query: 'WASM', cwd: gig })[0]?.nativeThreadId).toBe(ids[0])
  expect(catalog.search({ query: 'no-relevant-task', cwd: gig })).toEqual([])
})
it('distinguishes metadata-only vs explicitly opted-in first-message previews', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '')] })
  expect(catalog.search({ query: 'WASM 编译内存' })).toHaveLength(0)
  catalog.importMetadata({ entries: [{ ...entry(ids[0]!, gig, ''), preview: 'WASM 编译内存和快照' }] })
  expect(catalog.search({ query: 'WASM 编译内存' })).toHaveLength(1)
  expect(catalog.routingCandidates({ query: 'WASM', limit: 3 })[0]!.summary).toContain('未验证')
  expect(catalog.metadataBenchmark().n).toBe(1)
})
it('accepts only bounded optional previews; rejects chat bodies or raw private histories', () => {
  // Preview is now an explicitly supported field (used only by the opt-in sync path).
  expect(() => catalog.importMetadata({ entries: [{ ...entry(ids[0]!, gig, 'GC'), preview: 'x'.repeat(221) }] })).toThrow()
  expect(() => catalog.importMetadata({ entries: [{ ...entry(ids[0]!, gig, 'GC'), messages: [] }] })).toThrow()
  expect(() => catalog.importMetadata({ entries: [{ ...entry(ids[0]!, gig, 'GC'), rawHistory: 'private content' }] })).toThrow()
  expect(catalog.stats().total).toBe(0)
})
it('upserts without duplicating and does not silently rebind the same native ID to another project', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, 'First')] })
  expect(catalog.importMetadata({ entries: [entry(ids[0]!, gig, 'Updated')] })).toMatchObject({ updated: 1, total: 1 })
  expect(() => catalog.importMetadata({ entries: [entry(ids[0]!, other, 'Updated')] })).toThrow()
  expect(catalog.stats().total).toBe(1)
})
it('lets an explicitly reviewed experience improve retrieval while preserving provenance and future metadata sync', () => {
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '技术总结')] })
  const experience = { nativeThreadId: ids[0], problem: 'GC Profiler native 空栈诊断', conclusion: '确认日志缺失原因和已使用的调用栈口径',
    evidence: [{ threadId: ids[0] }], nextStep: '尝试在引擎层补回完整链路', verified: false }
  catalog.importExperience({ experience })
  expect(catalog.stats().curated).toBe(1)
  expect(catalog.search({ query: 'native 空栈' })[0]?.hasExperience).toBe(true)
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '技术记录更新')] })
  expect(catalog.search({ query: 'native 空栈' })).toHaveLength(1)
  expect(() => catalog.importExperience({ experience: { ...experience, evidence: [{ threadId: ids[1] }] } })).toThrow()
})
it('does not offer internal sub-agent sessions as ordinary human-resumable model targets', () => {
  catalog.importMetadata({ entries: [
    { ...entry(ids[0]!, gig, 'GC Profiler'), sourceKind: 'subAgent' },
    entry(ids[1]!, gig, 'GC Profiler 主会话'),
  ] })
  expect(catalog.search({ query: 'GC Profiler' })).toHaveLength(2)
  expect(catalog.routingCandidates({ query: 'GC Profiler', cwd: gig, limit: 12 })).toHaveLength(1)
  expect(catalog.routingCandidates({ query: 'GC Profiler', cwd: gig, limit: 12 })[0]?.threadId).toBe(ids[1])
})
it('caps the candidate list and withholds raw session history from Router', () => {
  catalog.importMetadata({ entries: [
    entry(ids[0]!, gig, 'GC Profiler 空栈分析'),
    entry(ids[1]!, gig, 'GC 任务回收')
  ] })
  const cards = catalog.routingCandidates({ query: 'GC', cwd: gig, limit: 12 })
  expect(cards).toHaveLength(2)
  expect(cards[0]?.capabilities.send).toBe('user')
  expect(JSON.stringify(cards)).not.toContain('private message')
  expect(cards.every(card => card.threadId && card.projectName === 'GIGNew')).toBe(true)
})
it('freezes identical candidate identities with preview as the only evidence difference', () => {
  catalog.importMetadata({ entries: [
    { ...entry(ids[0]!, gig, ''), preview: 'WASM memory snapshot' },
    entry(ids[1]!, gig, 'WASM compilation'),
  ] })
  const pair = catalog.frozenCandidates({ query: 'WASM', limit: 12 })
  expect(pair.metadata.map(card => card.uid)).toEqual(pair.preview.map(card => card.uid))
  expect(pair.metadata).toHaveLength(2)
  expect(pair.metadata.some(card => card.summary.includes('snapshot'))).toBe(false)
  expect(pair.preview.some(card => card.summary.includes('snapshot'))).toBe(true)
  expect(catalog.stats().total).toBe(2)
  expect(store.tickets.list()).toEqual([])
})
it('Chinese bigrams handle unsegmented queries and reject an irrelevant single candidate', () => {
  expect(terms('增量快照')).toEqual(new Set(['增量','量快','快照']))
  catalog.importMetadata({ entries: [entry(ids[0]!, gig, '增量快照压缩')] })
  expect(catalog.search({ query: '增量快照' })).toHaveLength(1)
  expect(catalog.search({ query: '哈哈完全不同' })).toEqual([])
})
