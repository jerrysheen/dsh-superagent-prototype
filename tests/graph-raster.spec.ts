import { expect, it } from 'vitest'
import { prepareRaster, rasterTransform, nearestEdge, graphVisualMetrics, graphLabelLayout } from '../src/client/graph-raster.ts'
import type { KnowledgeNode } from '../src/app/knowledge-graph.ts'

const points = [{ id: 'a', x: 10, y: 20, radius: 3 }, { id: 'b', x: 90, y: 20, radius: 4 }]
const nodes: KnowledgeNode[] = points.map(point => ({ provider: 'codex', threadId: point.id, title: point.id, cwd: 'F:/Synthetic', projectName: 'Synthetic',
  updatedAt: 1, messages: 0, partial: false, topics: [{ label: '渲染同步', evidence: [] }] }))
const edges = [{ source: 'a', target: 'b', kind: 'reference' as const, score: 1, terms: [] }]
it('prepares only positioned relationships and indexes neighbors without mutating inputs', () => {
  const scene = prepareRaster(nodes, [...edges, { ...edges[0]!, target: 'missing' }], points)
  expect(scene.edges).toHaveLength(1)
  expect(scene.neighbors.get('a')).toEqual(new Set(['b']))
  expect(scene.incident.get('b')).toEqual([0])
  expect(scene.positions.get('a')).toEqual(points[0])
  expect(points[0]!.radius).toBe(3)
})
it('maps raster pixels to the same letterboxed mouse-anchored SVG camera coordinates', () => {
  const camera = { x: 15, y: -8, zoom: 2 }
  const transform = rasterTransform(2000, 600, camera, 2)
  const base = 600 / 540
  expect(transform.scale).toBeCloseTo(base * 2 * 2)
  expect(transform.x).toBeCloseTo(((2000 - 1000 * base) / 2 - 15 * base * 2) * 2)
  expect(transform.y).toBeCloseTo(8 * base * 2 * 2)
})
it('keeps edge selection usable with a screen-space hit tolerance at different zooms', () => {
  const scene = prepareRaster(nodes, edges, points)
  expect(nearestEdge(scene, { x: 50, y: 21 }, 2)?.source).toBe('a')
  expect(nearestEdge(scene, { x: 50, y: 25 }, 2)).toBeUndefined()
  expect(nearestEdge(scene, { x: 300, y: 20 }, 2)).toBeUndefined()
})
it('keeps links subpixel and node sizes bounded at the maximum zoom', () => {
  for (const scale of [.2, 1, 5, 30]) for (const radius of [.02, 6]) {
    const metrics = graphVisualMetrics(radius, 1, scale)
    expect(metrics.lineWidth * scale).toBeCloseTo(.55)
    expect(metrics.radius * scale).toBeLessThanOrEqual(10)
    expect(metrics.radius * scale).toBeGreaterThanOrEqual(1.25)
  }
})
it('reveals readable labels on zoom, avoids collisions and prioritizes the focused conversation', () => {
  const positioned = [{ id: 'a', x: 200, y: 100, radius: 3 }, { id: 'b', x: 210, y: 102, radius: 3 }, { id: 'c', x: 450, y: 100, radius: 3 }]
  const scene = prepareRaster(positioned.map(p => ({ ...nodes[0]!, threadId: p.id, title: '一个较长的会话标题用于说明渲染同步问题' })), [], positioned)
  expect(graphLabelLayout(scene, { x: 0, y: 0, zoom: 1 }, 1000, 540, true, '', 1)).toEqual([])
  const labels = graphLabelLayout(scene, { x: 150, y: 50, zoom: 2 }, 1000, 540, true, 'b', 1)
  expect(labels[0]?.id).toBe('b')
  expect(labels.map(label => label.id)).not.toContain('a')
  expect(labels.map(label => label.id)).toContain('c')
  expect(labels.every(label => label.lines.length <= 2 && label.fontSize <= 13)).toBe(true)
  expect(graphLabelLayout(scene, { x: 0, y: 0, zoom: 1 }, 1000, 540, false, 'a', 1).map(label => label.id)).toEqual(['a'])
})
