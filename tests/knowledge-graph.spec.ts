import { expect, it, vi } from 'vitest'
import { contentDocument, knowledgeEdges, KnowledgeIndex, type KnowledgeNode } from '../src/app/knowledge-graph.ts'
import type { CodexTranscript } from '../src/app/codex-transcript.ts'
import { knowledgeLayout } from '../src/client/knowledge-layout.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const id = (value: number) => '01a1a0f6-353d-7581-b6dd-' + String(value).padStart(12, '0')
const node = (value: number): KnowledgeNode => ({ provider: 'codex', threadId: id(value), title: 'Discussion ' + value,
  cwd: 'F:/Project', projectName: 'Project', updatedAt: value, messages: 0, partial: false })
const transcript = (value: number, text: string): CodexTranscript => ({ threadId: id(value), nextCursor: null,
  turns: [{ id: 'turn-' + value, startedAt: value, status: 'completed', messages: [{ id: 'message-' + value, role: 'assistant', text, truncated: false }] }] })
const catalog = { threads: () => ({ threads: [node(1), node(2), node(3)], total: 3, nextOffset: null, revisedAt: '' }) }

it('projects local organization onto cached nodes without rereading transcripts or inventing relationships', async () => {
  const organization = { nativeThreadId: id(1), title: '主线程与渲染线程同步', category: '渲染架构与线程同步',
    summary: '讨论跨帧数据所有权与同步点。', kind: 'discussion' as const, coverage: 'recent-turns' as const,
    evidence: [{ threadId: id(1) }], reviewedAt: '2026-11-04T08:00:00.000Z' }
  let organized = false
  const source = { ...catalog, threads: () => ({ ...catalog.threads(), threads: [{ ...node(1), title: organized ? organization.title : '未命名 Codex 会话' }, node(2), node(3)] }),
    organizations: () => organized ? [organization] : [] }
  const read = vi.fn(async (input: unknown) => transcript(Number((input as { threadId: string }).threadId.slice(-12)), 'frame lifetime'))
  const index = new KnowledgeIndex(source, read)
  index.start({ confirmed: true })
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  const edges = index.snapshot().edges
  organized = true
  expect(index.snapshot().nodes[0]).toMatchObject({ title: organization.title, organization,
    topics: expect.arrayContaining([{ label: organization.category, evidence: ['内容整理'] }]) })
  expect(index.snapshot().edges).toEqual(edges)
  index.start({ confirmed: true })
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  expect(read).toHaveBeenCalledTimes(3)
})

it('builds content similarity evidence and leaves unrelated same-project conversations unconnected', () => {
  const edges = knowledgeEdges([
    contentDocument(node(1), transcript(1, 'WASM memory allocator heap fragmentation performance optimization')),
    contentDocument(node(2), transcript(2, 'WASM memory allocator heap fragmentation profiling optimization')),
    contentDocument(node(3), transcript(3, 'garden roses flowers soil sunshine watering seasons')),
  ])
  expect(edges).toHaveLength(1)
  expect(edges[0]).toMatchObject({ kind: 'similarity', source: id(1), target: id(2) })
  expect(edges[0]!.score).toBeGreaterThan(.4)
  expect(edges[0]!.terms).toContain('memory')
})
it('preserves directional explicit references with source turn IDs and does not invent external nodes', () => {
  const edges = knowledgeEdges([
    contentDocument(node(1), transcript(1, 'Related conversation codex://threads/' + id(2) + ' and codex://threads/' + id(9))),
    contentDocument(node(2), transcript(2, 'garden flowers')),
  ])
  expect(edges).toEqual([{ source: id(1), target: id(2), kind: 'reference', score: 1, terms: [], turnId: 'turn-1' }])
})
it('requires an explicit bounded indexing request and returns graph evidence without raw transcripts', async () => {
  const read = vi.fn(async (input: unknown) => {
    const threadId = (input as { threadId: string }).threadId
    return transcript(Number(threadId.slice(-12)), 'Synthetic raw transcript sentence for indexing; WASM memory allocator heap fragmentation')
  })
  const index = new KnowledgeIndex(catalog, read)
  expect(index.snapshot().status).toBe('idle'); expect(read).not.toHaveBeenCalled()
  expect(() => index.start({ confirmed: false })).toThrow()
  expect(() => index.start({ confirmed: true, limit: 100001 })).toThrow()
  index.start({ confirmed: true, limit: 2, turns: 3 })
  expect(() => index.start({ confirmed: true })).toThrow('正在建立')
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  const graph = index.snapshot()
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[0]![0]).toMatchObject({ limit: 3 })
  expect(graph).toMatchObject({ total: 2, completed: 2, scope: { limit: 2, turns: 3 } })
  expect(graph.nodes).toHaveLength(2)
  expect(JSON.stringify(graph)).not.toContain('Synthetic raw transcript sentence')
  expect(JSON.stringify(graph)).not.toContain('weights')
})
it('stops after the in-flight read and discards its result, including after a new build starts', async () => {
  let release!: (value: CodexTranscript) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise<CodexTranscript>(resolve => { release = resolve }))
    .mockImplementation(async (input: { threadId: string }) => transcript(Number(input.threadId.slice(-12)), 'new build memory heap allocator'))
  const index = new KnowledgeIndex(catalog, read)
  index.start({ confirmed: true, limit: 2 })
  index.cancel(); expect(index.snapshot().status).toBe('cancelled')
  index.start({ confirmed: true, limit: 2 })
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  release(transcript(1, 'old cancelled build'))
  await Promise.resolve(); await Promise.resolve()
  expect(index.snapshot().nodes).toHaveLength(2)
  expect(index.snapshot().completed).toBe(2)
  expect(read).toHaveBeenCalledTimes(3)
})
it('records per-thread failures and retains isolated and empty conversations without fabricated links', async () => {
  const read = vi.fn(async (input: unknown) => {
    const threadId = (input as { threadId: string }).threadId
    if (threadId === id(1)) throw new Error('Synthetic private error detail')
    return { threadId, turns: [], nextCursor: null }
  })
  const index = new KnowledgeIndex(catalog, read)
  index.start({ confirmed: true, limit: 3, cwd: 'f:\\project' })
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  expect(index.snapshot().failed).toEqual([id(1)])
  expect(index.snapshot().nodes).toHaveLength(3)
  expect(index.snapshot().edges).toEqual([])
  expect(JSON.stringify(index.snapshot())).not.toContain('private error')
})
it('lays out actual relationship components deterministically and stays inside the initial viewport', () => {
  const nodes = [node(1), node(2), node(3)]
  const edges = [{ source: id(1), target: id(2), kind: 'similarity' as const, score: .6, terms: ['memory'] }]
  const points = knowledgeLayout(nodes, edges)
  expect(points).toEqual(knowledgeLayout(nodes, edges))
  expect(points).toHaveLength(3)
  expect(points.every(point => point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 540 && Number.isFinite(point.radius))).toBe(true)
  expect(knowledgeLayout([], [])).toEqual([])
})
it('classifies content with evidence and connects normalized shared files only within the same project', () => {
  const first = contentDocument(node(1), transcript(1, 'worker engine session routing\n[implementation](/F:/Project/src/main.ts:12)\n[chat](thread://' + id(2) + '?hostId=local)'))
  const second = contentDocument(node(2), transcript(2, 'Inspect `src/main.ts` for the requested change'))
  const third = contentDocument({ ...node(3), cwd: 'F:/OtherProject' }, transcript(3, 'Inspect `src/main.ts`'))
  expect(first.node.topics).toEqual(expect.arrayContaining([expect.objectContaining({ label: '任务与 Agent 执行', evidence: expect.arrayContaining(['worker']) })]))
  expect(first.node.files).toEqual(['src/main.ts'])
  const edges = knowledgeEdges([first, second, third])
  expect(edges).toContainEqual(expect.objectContaining({ source: id(1), target: id(2), kind: 'reference', turnId: 'turn-1' }))
  expect(edges.filter(edge => edge.kind === 'shared-file')).toEqual([{ source: id(1), target: id(2), kind: 'shared-file', score: 1, terms: ['src/main.ts'] }])
})
it('processes the entire paginated catalog beyond 60 conversations', async () => {
  const nodes = Array.from({ length: 125 }, (_, index) => node(index + 1))
  const all = { threads: (input: unknown) => {
    const { offset = 0, limit = 100 } = input as { offset?: number; limit?: number }
    return { threads: nodes.slice(offset, offset + limit), total: nodes.length, nextOffset: offset + limit < nodes.length ? offset + limit : null, revisedAt: '' }
  } }
  const read = vi.fn(async (input: unknown) => ({ threadId: (input as { threadId: string }).threadId, turns: [], nextCursor: null }))
  const index = new KnowledgeIndex(all, read)
  index.start({ confirmed: true })
  await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
  expect(index.snapshot().total).toBe(125)
  expect(index.snapshot().nodes).toHaveLength(125)
  expect(read).toHaveBeenCalledTimes(125)
})
it('reads older content pages, persists derived cache, restores and reuses unchanged conversations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-cache-test-')), cache = join(directory, 'graph.json')
  try {
    const read = vi.fn(async (input: unknown) => {
      const query = input as { threadId: string; cursor?: string }
      const value = Number(query.threadId.slice(-12))
      return { ...transcript(value, query.cursor ? 'old memory allocator heap profiling' : 'unique synthetic raw message text'), nextCursor: query.cursor ? null : 'older' }
    })
    const index = new KnowledgeIndex(catalog, read, cache)
    index.start({ confirmed: true })
    await vi.waitFor(() => expect(index.snapshot().status).toBe('ready'))
    expect(read).toHaveBeenCalledTimes(6)
    expect(index.snapshot().nodes[0]!.messages).toBe(2)
    expect(readFileSync(cache, 'utf8')).not.toContain('unique synthetic raw message text')
    const secondRead = vi.fn(async (input: unknown) => transcript(Number((input as { threadId: string }).threadId.slice(-12)), 'updated body'))
    const restored = new KnowledgeIndex(catalog, secondRead, cache)
    expect(restored.snapshot().nodes).toHaveLength(3)
    restored.start({ confirmed: true })
    await vi.waitFor(() => expect(restored.snapshot().status).toBe('ready'))
    expect(secondRead).not.toHaveBeenCalled()
    expect(restored.snapshot().cached).toBe(3)
    const changed = { threads: () => ({ ...catalog.threads(), threads: [ { ...node(1), updatedAt: 999 }, node(2), node(3) ] }) }
    const incremental = new KnowledgeIndex(changed, secondRead, cache)
    incremental.start({ confirmed: true })
    await vi.waitFor(() => expect(incremental.snapshot().status).toBe('ready'))
    expect(secondRead).toHaveBeenCalledTimes(1)
    expect(incremental.snapshot().cached).toBe(2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it('handles a thousand-node content graph with bounded similarity candidates and a finite layout', () => {
  const docs = Array.from({ length: 1000 }, (_, index) => contentDocument(node(index + 1), transcript(index + 1,
    Array.from({ length: 100 }, (_, term) => 'topic' + Math.floor(index / 50) + 'word' + term).join(' '))))
  const edges = knowledgeEdges(docs)
  expect(edges.length).toBeGreaterThan(0)
  expect(edges.filter(edge => edge.kind === 'similarity').length).toBeLessThanOrEqual(2000)
  const points = knowledgeLayout(docs.map(doc => doc.node), edges)
  expect(points).toHaveLength(1000)
  expect(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
}, 15000)
it('persists a partially processed conversation and resumes at its failed older page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-resume-test-')), cache = join(directory, 'graph.json')
  const one = { threads: () => ({ threads: [node(1)], total: 1, nextOffset: null, revisedAt: '' }) }
  try {
    const first = new KnowledgeIndex(one, async (input: unknown) => {
      if ((input as { cursor?: string }).cursor) throw new Error('Synthetic older-page timeout')
      return { ...transcript(1, 'first memory heap allocator'), nextCursor: 'older' }
    }, cache)
    first.start({ confirmed: true })
    await vi.waitFor(() => expect(first.snapshot().status).toBe('ready'))
    expect(first.snapshot().failed).toEqual([id(1)])
    expect(first.snapshot().nodes[0]!.messages).toBe(1)
    const read = vi.fn(async () => transcript(1, 'older memory heap allocator'))
    const restored = new KnowledgeIndex(one, read, cache)
    restored.start({ confirmed: true })
    await vi.waitFor(() => expect(restored.snapshot().status).toBe('ready'))
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cursor: 'older' }))
    expect(restored.snapshot().failed).toEqual([])
    expect(restored.snapshot().nodes[0]).toMatchObject({ messages: 2, partial: false })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
