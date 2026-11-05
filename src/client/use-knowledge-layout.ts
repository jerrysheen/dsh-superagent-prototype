import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeNode, KnowledgeEdge } from '../app/knowledge-graph.ts'
import { knowledgeLayout, layoutTopology, scheduleKnowledgeLayout, type GraphPoint, type LayoutSettings } from './knowledge-layout.ts'
import { readLayoutCache, writeLayoutCache } from './graph-layout-cache.ts'

export function useKnowledgeLayout(nodes: KnowledgeNode[], edges: KnowledgeEdge[], settings: LayoutSettings) {
  const topology = layoutTopology(nodes, edges), large = nodes.length > 200
  const [settled, setSettled] = useState<GraphPoint[]>([])
  // Metadata, message counts and organization summaries do not affect force geometry.
  const immediate = useMemo(() => large ? [] : knowledgeLayout(nodes, edges, settings), [topology, settings, large])
  useEffect(() => {
    if (!large) return
    const cached = readLayoutCache(topology, settings, nodes.map(node => node.threadId))
    if (cached) { performance.mark?.('dsh-graph-layout-cache-hit'); setSettled(cached); return }
    performance.mark?.('dsh-graph-layout-compute')
    let persist: ReturnType<typeof setTimeout> | undefined
    const cancel = scheduleKnowledgeLayout(nodes, edges, settings, points => {
      setSettled(points)
      persist = setTimeout(() => writeLayoutCache(topology, settings, points), 0)
    })
    return () => { cancel(); clearTimeout(persist) }
  }, [topology, settings, large])
  const ids = useMemo(() => new Set(nodes.map(node => node.threadId)), [topology])
  return useMemo(() => large ? settled.filter(point => ids.has(point.id)) : immediate, [large, settled, ids, immediate])
}
