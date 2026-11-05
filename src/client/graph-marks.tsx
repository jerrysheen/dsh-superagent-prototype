import { memo, useEffect, useMemo, useRef } from 'react'
import type { KnowledgeEdge, KnowledgeNode } from '../app/knowledge-graph.ts'
import type { GraphPoint } from './knowledge-layout.ts'

interface Props { nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; points: GraphPoint[]; selected: string; labels: boolean;
  nodeScale: number; opacity: number; colorGroups: boolean; onSelect: (id: string) => void }
/** Static SVG marks, memoized independently from settings/panels and camera input. */
export const GraphMarks = memo(function GraphMarks({ nodes, edges, points, selected, labels, nodeScale, opacity, colorGroups, onSelect }: Props) {
  const root = useRef<SVGGElement>(null), hoverLabel = useRef<SVGTextElement>(null)
  const positions = useMemo(() => new Map(points.map(point => [point.id, point])), [points])
  const names = useMemo(() => new Map(nodes.map(node => [node.threadId, node])), [nodes])
  const topics = useMemo(() => [...new Set(nodes.flatMap(node => node.topics?.map(topic => topic.label) ?? []))].sort(), [nodes])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const nodeElements = new Map([...element.querySelectorAll<SVGGElement>('[data-node]')].map(node => [node.dataset.node!, node]))
    const edgeElements = [...element.querySelectorAll<SVGLineElement>('[data-edge]')]
    const adjacent = new Map<string, { nodes: Set<string>; edges: number[] }>()
    edges.forEach((edge, index) => {
      for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        const group = adjacent.get(from!) ?? { nodes: new Set<string>(), edges: [] }
        group.nodes.add(to!); group.edges.push(index); adjacent.set(from!, group)
      }
    })
    let current: string | undefined, highlightedNodes = new Set<string>(), highlightedEdges: number[] = []
    const focus = (id: string) => {
      if (current === id) return
      for (const node of highlightedNodes) nodeElements.get(node)?.removeAttribute('data-neighbor')
      for (const index of highlightedEdges) edgeElements[index]?.removeAttribute('data-highlight')
      current = id
      element.dispatchEvent(new CustomEvent('graphfocus', { bubbles: true, detail: id }))
      const raster = element.closest('svg')?.hasAttribute('data-raster')
      if (!raster) element.toggleAttribute('data-focus', !!id)
      const group = adjacent.get(id)
      highlightedNodes = new Set(id ? [id, ...group?.nodes ?? []] : [])
      highlightedEdges = group?.edges ?? []
      if (!raster) {
        for (const node of highlightedNodes) nodeElements.get(node)?.setAttribute('data-neighbor', '')
        for (const index of highlightedEdges) edgeElements[index]?.setAttribute('data-highlight', '')
      }
      const point = positions.get(id), node = names.get(id), label = hoverLabel.current
      if (label) {
        label.textContent = point && node ? (node.title.length > 36 ? node.title.slice(0, 36) + '…' : node.title) : ''
        if (point) { label.setAttribute('x', String(point.x)); label.setAttribute('y', String(point.y + point.radius * nodeScale + 14)) }
      }
    }
    const over = (event: Event) => {
      const svg = element.closest('svg')
      if (svg?.hasAttribute('data-panning') || svg?.hasAttribute('data-camera-moving')) return
      const node = (event.target as Element).closest<SVGGElement>('[data-node]')
      focus(node?.dataset.node ?? selected)
    }
    const leave = () => focus(selected)
    element.addEventListener('pointerover', over); element.addEventListener('focusin', over); element.addEventListener('pointerleave', leave)
    focus(selected)
    return () => {
      element.removeEventListener('pointerover', over); element.removeEventListener('focusin', over); element.removeEventListener('pointerleave', leave)
      for (const node of highlightedNodes) nodeElements.get(node)?.removeAttribute('data-neighbor')
      for (const index of highlightedEdges) edgeElements[index]?.removeAttribute('data-highlight')
      element.removeAttribute('data-focus'); if (hoverLabel.current) hoverLabel.current.textContent = ''
    }
  }, [edges, points, names, positions, nodeScale, selected])
  return <g ref={root} className="kg-marks" data-labels={labels || undefined} style={{ '--kg-edge-opacity': opacity } as React.CSSProperties}>
    {edges.map((edge, index) => {
      const a = positions.get(edge.source), b = positions.get(edge.target)
      return a && b ? <line key={edge.kind + ':' + edge.source + ':' + edge.target} data-edge={index} tabIndex={0} role="button"
        aria-label={'查看关联：' + names.get(edge.source)?.title + ' → ' + names.get(edge.target)?.title} onClick={() => onSelect(edge.source)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(edge.source) } }}
        x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={'kg-edge kg-edge-' + edge.kind}>
        <title>{edge.kind === 'contains' ? '分类归属' : edge.kind === 'co-discussed' ? '共同讨论 · 候选关联 · '+edge.terms.join(' · ') : edge.kind === 'reference' ? '明确引用' : edge.kind === 'shared-file' ? '共同文件 · ' + edge.terms.join(' / ') : `文本相似 ${Math.round(edge.score * 100)}% · ${edge.terms.join(' / ')}`}</title>
      </line> : null
    })}
    {points.map(point => { const node = names.get(point.id)!; return <g key={point.id} data-node={point.id} className="kg-node" transform={`translate(${point.x},${point.y})`}
      data-selected={selected === point.id || undefined} tabIndex={0} role="button" aria-label={node.title} aria-pressed={selected === point.id}
      onClick={() => onSelect(point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id) } }}>
      <title>{node.title + '\n' + node.projectName + ' · ' + node.messages + ' 条消息'}</title>
      <circle className="kg-node-hit" r={Math.max(3.5, point.radius * nodeScale + 1.5)} />
      <circle className="kg-node-dot" style={colorGroups && selected !== point.id ? { fill: ['#8ca5c4', '#b69cc6', '#94b89f', '#c3ad8c', '#94b9bb', '#ba979c'][Math.max(0, topics.indexOf(node.topics?.[0]?.label ?? '')) % 6] } : undefined} r={point.radius * nodeScale} />
      <text y={point.radius * nodeScale + 14} textAnchor="middle">{node.title.length > 36 ? node.title.slice(0, 36) + '…' : node.title}</text>
    </g> })}
    <text ref={hoverLabel} className="kg-hover-label" textAnchor="middle" />
  </g>
})
