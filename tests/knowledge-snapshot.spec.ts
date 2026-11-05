import { expect, it } from 'vitest'
import { reconcileKnowledgeSnapshot } from '../src/client/knowledge-snapshot.ts'
import type { KnowledgeGraph } from '../src/app/knowledge-graph.ts'
const graph: KnowledgeGraph = { status: 'indexing', completed: 1, total: 2, builtAt: null, scope: null, failed: [], edges: [],
  nodes: [{ provider: 'codex', threadId: 'a', title: 'A', cwd: 'F:/Synthetic', projectName: 'Synthetic', messages: 2, partial: false, updatedAt: 1 }] }
it('keeps scene references through progress-only polling while accepting changed content', () => {
  const progress = reconcileKnowledgeSnapshot(graph, { ...structuredClone(graph), completed: 2, status: 'ready' })
  expect(progress.nodes).toBe(graph.nodes); expect(progress.edges).toBe(graph.edges); expect(progress.completed).toBe(2)
  const changed = reconcileKnowledgeSnapshot(progress, { ...progress, nodes: [{ ...progress.nodes[0]!, title: 'B' }] })
  expect(changed.nodes).not.toBe(progress.nodes); expect(changed.nodes[0]!.title).toBe('B')
  expect(changed.edges).toBe(graph.edges)
})
