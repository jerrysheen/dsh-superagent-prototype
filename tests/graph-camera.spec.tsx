// @vitest-environment jsdom
import { Profiler, act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useGraphCamera, viewportPoint, zoomAt, type Camera } from '../src/client/graph-camera.ts'
import { GraphMarks } from '../src/client/graph-marks.tsx'
import type { KnowledgeNode } from '../src/app/knowledge-graph.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, frames: Map<number, FrameRequestCallback>, nextFrame = 0
beforeEach(() => {
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(16) }
const worldAt = (camera: Camera, point: { x: number; y: number }) => ({ x: camera.x + point.x / camera.zoom, y: camera.y + point.y / camera.zoom })
it('preserves the world coordinate under the cursor across wide/tall viewports and zoom limits', () => {
  for (const rect of [{ left: 30, top: 40, width: 2000, height: 600 }, { left: 100, top: 50, width: 600, height: 1200 }]) {
    const anchor = viewportPoint({ x: rect.left + rect.width * .63, y: rect.top + rect.height * .44 }, rect)
    const before = { x: 43, y: -18, zoom: 2.4 }
    for (const factor of [1.37, .72, 1e8, 1e-8]) {
      const after = zoomAt(before, factor, anchor), original = worldAt(before, anchor), actual = worldAt(after, anchor)
      expect(actual.x).toBeCloseTo(original.x, 9); expect(actual.y).toBeCloseTo(original.y, 9)
      expect(after.zoom).toBeGreaterThanOrEqual(.15); expect(after.zoom).toBeLessThanOrEqual(20)
    }
  }
})
const nodes: KnowledgeNode[] = Array.from({ length: 1138 }, (_, index) => ({ provider: 'codex', threadId: 'node-' + index, title: 'Synthetic node ' + index,
  cwd: 'F:/Synthetic', projectName: 'Synthetic', updatedAt: 1, messages: 2, partial: false }))
const points = nodes.map((node, index) => ({ id: node.threadId, x: index % 50 * 18, y: Math.floor(index / 50) * 18, radius: 2 }))
const edges = Array.from({ length: 5356 }, (_, index) => ({ source: nodes[index % nodes.length]!.threadId,
  target: nodes[(index + 11 + Math.floor(index / nodes.length) * 31) % nodes.length]!.threadId, kind: 'similarity' as const, score: .5, terms: ['memory'] }))
function mount() { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); return host }
function Harness({ committed, selected }: { committed: () => void; selected: (id: string) => void }) {
  const svg = useRef<SVGSVGElement>(null), scene = useRef<SVGGElement>(null)
  useGraphCamera(svg, scene)
  return <svg ref={svg} viewBox="0 0 1000 540"><g ref={scene} className="kg-scene" transform="translate(0 0) scale(1)">
    <Profiler id="marks" onRender={committed}><GraphMarks nodes={nodes} points={points} edges={edges} selected="" labels={false} nodeScale={1} opacity={.22} colorGroups={false} onSelect={selected} /></Profiler>
  </g></svg>
}
it('coalesces 120 wheel events into one transform with no React commits or mark mutations at full graph size', async () => {
  const host = mount(), committed = vi.fn(), selected = vi.fn()
  await act(async () => root!.render(<Harness committed={committed} selected={selected} />))
  const svg = host.querySelector('svg')!, scene = host.querySelector('.kg-scene')!, marks = host.querySelector('.kg-marks')!
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 800 } as DOMRect)
  committed.mockClear()
  const mutations = new MutationObserver(() => {})
  mutations.observe(marks, { childList: true, attributes: true, subtree: true })
  const anchor = viewportPoint({ x: 1100, y: 260 }, svg.getBoundingClientRect())
  for (let index = 0; index < 120; index++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 1100, clientY: 260, cancelable: true }))
  expect(frames.size).toBe(1)
  expect(scene.getAttribute('transform')).toBe('translate(0 0) scale(1)')
  flush()
  const values = scene.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number)
  expect(values[0]! + anchor.x * values[2]!).toBeCloseTo(anchor.x, 8)
  expect(values[1]! + anchor.y * values[2]!).toBeCloseTo(anchor.y, 8)
  expect(committed).not.toHaveBeenCalled()
  expect(mutations.takeRecords()).toHaveLength(0)
  expect(host.querySelectorAll('[data-node]')).toHaveLength(1138)
  expect(host.querySelectorAll('[data-edge]')).toHaveLength(5356)
  mutations.disconnect()
  const node = host.querySelector('[data-node="node-0"]')!
  node.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
  expect(host.querySelectorAll('[data-highlight]').length).toBeGreaterThan(0)
  expect(committed).not.toHaveBeenCalled()
}, 15000)
it('pans only with the middle button, prevents autoscroll and keeps the next left click usable', async () => {
  const host = mount(), selected = vi.fn()
  await act(async () => root!.render(<Harness committed={() => {}} selected={selected} />))
  const svg = host.querySelector('svg')!, node = host.querySelector('[data-node="node-0"]')!
  svg.getBoundingClientRect = () => ({ left: 20, top: 30, width: 2000, height: 600 } as DOMRect)
  const pointer = (type: string, x: number, y: number, button = 1) => { const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event }
  node.dispatchEvent(pointer('pointerdown', 800, 300, 0))
  svg.dispatchEvent(pointer('pointermove', 900, 350, 0)); svg.dispatchEvent(pointer('pointerup', 900, 350, 0)); flush()
  expect(host.querySelector('.kg-scene')!.getAttribute('transform')).toBe('translate(0 0) scale(1)')
  const down = pointer('pointerdown', 800, 300)
  node.dispatchEvent(down); expect(down.defaultPrevented).toBe(true)
  svg.dispatchEvent(pointer('pointermove', 900, 350)); svg.dispatchEvent(pointer('pointerup', 900, 350)); flush()
  const values = host.querySelector('.kg-scene')!.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number)
  expect(values[0]).toBeCloseTo(90); expect(values[1]).toBeCloseTo(45)
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }))
  expect(selected).not.toHaveBeenCalled()
  node.dispatchEvent(pointer('pointerdown', 800, 300, 0)); node.dispatchEvent(pointer('pointerup', 800, 300, 0))
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(selected).toHaveBeenCalledWith('node-0')
}, 15000)
