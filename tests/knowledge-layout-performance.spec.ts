import { expect, it, vi } from 'vitest'
import { layoutTopology, scheduleKnowledgeLayout, knowledgeLayout } from '../src/client/knowledge-layout.ts'
import type { KnowledgeNode } from '../src/app/knowledge-graph.ts'
const nodes = Array.from({ length: 300 }, (_, i) => ({ provider: 'codex', threadId: 'n' + i, title: 'Node ' + i,
  projectName: 'Project', cwd: 'F:/Project', updatedAt: 1, partial: false, messages: 0 })) as KnowledgeNode[]
const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i]!.threadId, target: node.threadId, kind: 'similarity' as const, score: .5, terms: [] }))
it('ignores progress, titles and summary updates in the layout key but responds to actual topology changes', () => {
  expect(layoutTopology(nodes, edges)).toBe(layoutTopology(nodes.map(node => ({ ...node, title: 'Renamed', messages: 18 })), structuredClone(edges)))
  expect(layoutTopology(nodes, edges)).not.toBe(layoutTopology(nodes, edges.slice(1)))
  expect(layoutTopology(nodes, edges)).not.toBe(layoutTopology(nodes.map(node => ({ ...node, topics: [{ label: 'Different', evidence: [] }] })), edges))
})
it('yields between bounded simulation chunks, publishes the same final layout and cancels obsolete work', () => {
  const queue = new Map<number, FrameRequestCallback>(); let next = 0
  const schedule = (callback: FrameRequestCallback) => { queue.set(++next, callback); return next }
  const cancel = (id: number) => { queue.delete(id) }
  const publish = vi.fn()
  const dispose = scheduleKnowledgeLayout(nodes, edges, {}, publish, schedule, cancel)
  expect(publish).not.toHaveBeenCalled(); expect(queue.size).toBe(1)
  const step = () => { const pending = [...queue.values()]; queue.clear(); pending.forEach(callback => callback(16)) }
  step(); expect(publish).not.toHaveBeenCalled(); expect(queue.size).toBe(1)
  while (queue.size) step()
  expect(publish).toHaveBeenCalledOnce()
  expect(publish.mock.calls[0]![0]).toEqual(knowledgeLayout(nodes, edges))
  dispose()
  const cancelled = vi.fn()
  const stop = scheduleKnowledgeLayout(nodes, edges, {}, cancelled, schedule, cancel)
  stop(); expect(queue.size).toBe(0); expect(cancelled).not.toHaveBeenCalled()
})
