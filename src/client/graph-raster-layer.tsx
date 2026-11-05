import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { KnowledgeNode, KnowledgeEdge } from '../app/knowledge-graph.ts'
import type { GraphPoint } from './knowledge-layout.ts'
import { mountRaster, prepareRaster, type RasterCamera, type RasterOptions } from './graph-raster.ts'

export function GraphRasterLayer({ svg, camera, nodes, edges, points, ...options }: RasterOptions & {
  svg: RefObject<SVGSVGElement>; camera: RasterCamera; nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; points: GraphPoint[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useMemo(() => prepareRaster(nodes, edges, points), [nodes, edges, points])
  useEffect(() => {
    if (canvas.current && svg.current) return mountRaster(canvas.current, svg.current, camera, scene, options)
  }, [svg, camera, scene, options.nodeScale, options.opacity, options.colorGroups, options.selected, options.labels, options.onSelect])
  return <canvas ref={canvas} className="kg-raster" aria-hidden="true" />
}
