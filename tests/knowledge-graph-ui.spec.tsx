// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LegacyKnowledgeGraphWindow as KnowledgeGraphWindow } from '../src/client/knowledge-graph.tsx'
import type { KnowledgeGraph } from '../src/app/knowledge-graph.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const idle: KnowledgeGraph = { status: 'idle', completed: 0, total: 0, nodes: [], edges: [], failed: [], builtAt: null, scope: null }
const graph: KnowledgeGraph = { ...idle, status: 'ready', completed: 2, total: 2, builtAt: '2026-11-04T04:00:00Z', scope: { cwd: '', limit: 20, turns: 5 },
  nodes: [1, 2].map(value => ({ provider: 'codex', threadId: 'thread-' + value, title: 'Synthetic discussion ' + value, cwd: 'F:/Project', projectName: 'Project', updatedAt: value, messages: 4, partial: true })),
  edges: [{ source: 'thread-1', target: 'thread-2', kind: 'similarity', score: .62, terms: ['memory', 'heap', 'allocator'] }] }
const metadata = { threads: [{ cwd: 'F:/Project', projectName: 'Project' }], nextOffset: null }
function mount() { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); return host }
it('shows the shared-file backbone by default and restores all links without moving nodes', async () => {
  const host = mount(), nodes=Array.from({length:12},(_,i)=>({...graph.nodes[0]!,threadId:'clique-'+i,title:'Renderer discussion '+i}))
  const edges=nodes.flatMap((node,i)=>nodes.slice(i+1).map(other=>({source:node.threadId,target:other.threadId,kind:'shared-file',score:1,terms:['src/renderer.cpp']})))
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...graph,nodes,edges})))
  await act(async()=>root!.render(<KnowledgeGraphWindow/>))
  expect(host.querySelectorAll('[data-node]')).toHaveLength(12)
  expect(host.querySelectorAll('.kg-edge').length).toBeLessThan(edges.length)
  const before=[...host.querySelectorAll('[data-node]')].map(node=>node.getAttribute('transform'))
  const toggle=[...host.querySelectorAll('label')].find(label=>label.textContent?.includes('显示全部关联'))!.querySelector<HTMLInputElement>('input')!
  await act(async()=>toggle.click())
  expect(host.querySelectorAll('.kg-edge')).toHaveLength(edges.length)
  expect([...host.querySelectorAll('[data-node]')].map(node=>node.getAttribute('transform'))).toEqual(before)
})
it('dismisses details on a blank left click or a second click on the selected node', async () => {
  const host = mount(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(graph)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  const node = host.querySelector('[data-node="thread-1"]')!, svg = host.querySelector('svg.kg-svg')!
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('.kg-inspector')).not.toBeNull()
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('.kg-inspector')).toBeNull()
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await act(async () => svg.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('.kg-inspector')).toBeNull()
})
it('does not enable the unbounded SVG label layer when automatic Canvas labels are on', async () => {
  const host = mount()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(graph)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  expect(host.querySelector('.kg-marks')!.hasAttribute('data-labels')).toBe(false)
})
it('keeps the raster SVG text layer hidden even if its legacy labels flag is enabled', async () => {
  const host = mount()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(graph)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  const style = document.createElement('style'); style.textContent = readFileSync(join(process.cwd(), 'src/client/knowledge-graph.css'), 'utf8'); host.append(style)
  host.querySelector('svg.kg-svg')!.setAttribute('data-raster', '')
  host.querySelector('.kg-marks')!.setAttribute('data-labels', '')
  expect(getComputedStyle(host.querySelector('.kg-node text')!).display).toBe('none')
})
it('shows the reviewed summary and its limited reading scope beside the native conversation link', async () => {
  const host = mount()
  const organized = { ...graph, nodes: graph.nodes.map(node => ({ ...node, organization: {
    nativeThreadId: node.threadId, title: node.title, category: '性能剖析与内存', summary: '讨论 Buffer 生命周期和逐帧内存复用。',
    kind: 'discussion', coverage: 'recent-turns', evidence: [{ threadId: node.threadId }], reviewedAt: '2026-11-04T08:00:00.000Z' } })) }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(organized)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  await act(async () => host.querySelector('[data-node="thread-1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('aside')!.textContent).toContain('讨论 Buffer 生命周期和逐帧内存复用。')
  expect(host.querySelector('aside')!.textContent).toContain('尚未逐轮复核全部历史')
  expect(host.querySelector('aside a')!.getAttribute('href')).toBe('codex://threads/thread-1')
})
it('shows an honest empty state and does not index conversation content automatically', async () => {
  const host = mount(), fetch = vi.fn(async (url: string) => Response.json(url.includes('/context/') ? metadata : idle))
  vi.stubGlobal('fetch', fetch)
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  expect(host.textContent).toContain('让会话之间的关联浮现出来')
  expect(host.textContent).toContain('全部 0 条会话')
  expect(host.querySelectorAll('[data-node]')).toHaveLength(0)
  expect(fetch.mock.calls.every(([url]) => !url.includes('/transcript'))).toBe(true)
})
it('indexes only after a click, selects evidence, opens the chosen thread and supports zoom/reset in the full-page view', async () => {
  const host = mount(), open = vi.fn()
  const fetch = vi.fn(async (url: string, options?: RequestInit) => Response.json(url.includes('/context/') ? metadata : options?.method === 'POST' ? graph : idle))
  vi.stubGlobal('fetch', fetch)
  await act(async () => root!.render(<KnowledgeGraphWindow onOpenThread={open} />))
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!
  await act(async () => button('更新本地缓存').click())
  const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST')!
  expect(JSON.parse(post[1]!.body as string)).toEqual({ confirmed: true })
  expect(host.querySelectorAll('[data-node]')).toHaveLength(2)
  await act(async () => host.querySelector('[data-node="thread-1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('aside')!.textContent).toContain('共同关键词：memory、heap、allocator')
  expect(host.querySelector('aside a')!.getAttribute('href')).toBe('codex://threads/thread-1')
  await act(async () => button('查看会话').click())
  expect(open).toHaveBeenCalledWith(graph.nodes[0])
  const scene = host.querySelector('.kg-scene')!, before = scene.getAttribute('transform')
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="放大图谱"]')!.click(); await new Promise(resolve => requestAnimationFrame(resolve)) })
  expect(scene.getAttribute('transform')).not.toBe(before)
  await act(async () => { button('复位').click(); await new Promise(resolve => requestAnimationFrame(resolve)) })
  expect(scene.getAttribute('transform')).toBe(before)
  expect(host.textContent).not.toContain('展开视窗')
  expect(host.querySelector('.kg-expanded')).toBeNull()
})
it('filters reference and similarity edges separately without re-indexing or creating new edges', async () => {
  const host = mount(), withReference = { ...graph, edges: [...graph.edges, { source: 'thread-2', target: 'thread-1', kind: 'reference', score: 1, terms: [], turnId: 'original-turn' }] }
  const fetch = vi.fn(async (url: string) => Response.json(url.includes('/context/') ? metadata : withReference))
  vi.stubGlobal('fetch', fetch)
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  const select = host.querySelector<HTMLSelectElement>('[aria-label="关联类型"]')!
  await act(async () => { select.value = 'reference'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.querySelectorAll('.kg-edge')).toHaveLength(1)
  expect(host.querySelector('.kg-edge-reference')).not.toBeNull()
  // Initial graph plus the shared domain directory; filtering makes no further requests.
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('filters topic categories using content evidence and shows shared-file relationships distinctly', async () => {
  const host = mount(), classified = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, topics: index ? [] : [{ label: '任务与 Agent 执行', evidence: ['worker', 'engine'] }] })),
    edges: [{ source: 'thread-1', target: 'thread-2', kind: 'shared-file', score: 1, terms: ['src/main.ts'] }] }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/context/') ? metadata : classified)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  expect(host.querySelector('.kg-edge-shared-file')).not.toBeNull()
  const topics = host.querySelector<HTMLSelectElement>('[aria-label="主题归类"]')!
  await act(async () => { topics.value = '任务与 Agent 执行'; topics.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.querySelectorAll('[data-node]')).toHaveLength(1)
  expect(host.querySelectorAll('.kg-edge')).toHaveLength(0)
  await act(async () => host.querySelector('[data-node]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('.kg-inspector')!.textContent).toContain('worker、engine')
})
it('presents an unframed canvas with closeable floating controls and no separate heading/footer bands', async () => {
  const host = mount()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(graph)))
  await act(async () => root!.render(<KnowledgeGraphWindow />))
  const style = document.createElement('style'); style.textContent = readFileSync(join(process.cwd(), 'src/client/knowledge-graph.css'), 'utf8'); host.append(style)
  expect(host.querySelector('.kg-head, .kg-footnote')).toBeNull()
  expect(getComputedStyle(host.querySelector('.kg-canvas')!).borderTopWidth).toBe('0px')
  // jsdom normalizes SVG `none` to transparent paint in some versions.
  expect(['none', 'rgba(0, 0, 0, 0)']).toContain(getComputedStyle(host.querySelector('.kg-node-dot')!).stroke)
  expect(host.querySelector<HTMLInputElement>('[aria-label="中心力"]')).not.toBeNull()
  expect(host.querySelector<HTMLInputElement>('[aria-label="连线拉力"]')).not.toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭图谱设置"]')!.click())
  expect(getComputedStyle(host.querySelector('.kg-filter')!).display).toBe('none')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="打开图谱设置"]')!.click())
  expect(host.querySelector<HTMLElement>('.kg-filter')!.hidden).toBe(false)
  await act(async () => host.querySelector('[data-node="thread-1"]')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  expect(host.querySelector('.kg-edge[data-highlight]')).not.toBeNull()
})
