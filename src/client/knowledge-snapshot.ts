import type { KnowledgeGraph } from '../app/knowledge-graph.ts'
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]))
  if (Array.isArray(b)) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
}
/** Progress polling must not invalidate memoized geometry, SVG hits or raster paths. */
export function reconcileKnowledgeSnapshot(previous: KnowledgeGraph, next: KnowledgeGraph): KnowledgeGraph {
  return { ...next, nodes: equal(previous.nodes, next.nodes) ? previous.nodes : next.nodes,
    edges: equal(previous.edges, next.edges) ? previous.edges : next.edges }
}
