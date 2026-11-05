import { expect, it } from 'vitest'
import { organizeKnowledgeGraph, nodeView } from '../src/client/knowledge-communities.ts'
import { knowledgeLayout } from '../src/client/knowledge-layout.ts'
import { prepareRaster, graphLabelLayout } from '../src/client/graph-raster.ts'
import type { KnowledgeNode, KnowledgeEdge } from '../src/app/knowledge-graph.ts'
const node = (id: string, title = id): KnowledgeNode => ({ provider: 'codex', threadId: id, title, cwd: 'F:/OneProject', projectName: 'OneProject', messages: 8, partial: false, updatedAt: 1,
  topics: [{ label: '工程与配置', evidence: [] }] })
const edge = (a: string, b: string, kind: KnowledgeEdge['kind'] = 'similarity', terms: string[] = []): KnowledgeEdge => ({ source: a, target: b, kind, score: .9, terms })
it('groups strong content relationships independently of broad topic/project labels and keeps all native IDs', () => {
  const nodes = ['a','b','c','x','y','z'].map(id => node(id))
  const edges = [edge('a','b'),edge('a','c'),edge('b','c'),edge('x','y'),edge('x','z'),edge('y','z'),edge('c','x','shared-file',['README.md'])]
  const result = organizeKnowledgeGraph(nodes, edges)
  const byId = new Map(result.nodes.map(node => [node.threadId, nodeView(node)!]))
  expect(byId.get('a')!.community).toBe(byId.get('c')!.community)
  expect(byId.get('a')!.community).not.toBe(byId.get('x')!.community)
  expect(result.nodes.map(node => node.threadId)).toEqual(nodes.map(node => node.threadId))
  expect(result.edges.every(e => edges.includes(e))).toBe(true)
  expect(result.edges).not.toContain(edges.at(-1))
  expect(organizeKnowledgeGraph([...nodes].reverse(),[...edges].reverse()).groups).toEqual(result.groups)
})
it('sets aside tests, routine digests, missing-body records and unrelated substantive notes without deleting them', () => {
  const nodes = [node('a'),node('b'),{ ...node('test','Hello World'), messages: 1 },node('daily','每日 Codex 昨日学习总结'),{ ...node('pending'), messages: 0, partial: true },node('isolated','独立的深入技术讨论')]
  const result = organizeKnowledgeGraph(nodes, [edge('a','b')])
  expect(result.nodes.map(node => nodeView(node)!.role)).toEqual(['core','core','test','routine','pending','unlinked'])
  const points = new Map(knowledgeLayout(result.nodes, result.edges).map(point => [point.id, point]))
  expect(points.get('a')!.x).toBeLessThan(790)
  for (const id of ['test','daily','pending','isolated']) { expect(points.get(id)!.x).toBeGreaterThanOrEqual(810); expect(points.get(id)!.y).toBeGreaterThanOrEqual(300) }
  expect(result.nodes).toHaveLength(nodes.length)
  expect(nodeView(result.nodes[4]!)!.reason).toContain('未')
})
it('reduces a shared-file clique to a real-edge backbone with a larger representative node', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node('n' + i))
  const edges = nodes.flatMap((n,i) => nodes.slice(i+1).map(other => edge(n.threadId, other.threadId, 'shared-file', ['src/renderer.cpp'])))
  const result = organizeKnowledgeGraph(nodes, edges)
  expect(result.groups).toHaveLength(1)
  expect(result.edges.length).toBeLessThan(edges.length / 2)
  expect(result.edges.every(e => edges.includes(e))).toBe(true)
  const points = knowledgeLayout(result.nodes, result.edges), hub = result.groups[0]!.hub
  expect(points.find(point => point.id === hub)!.radius).toBeGreaterThan(Math.max(...points.filter(point => point.id !== hub).map(point => point.radius)))
  expect(result.nodes.filter(node => nodeView(node)!.hub)).toHaveLength(1)
  const labels=graphLabelLayout(prepareRaster(result.nodes,result.edges,points),{x:0,y:0,zoom:1},1000,540,true,'',1)
  expect(labels).toHaveLength(1)
  expect(labels[0]!.lines.join('')).toContain('12')
})
