/** Cached Canvas rendering; SVG retains node hit targets, labels and keyboard access. */
import type { KnowledgeEdge, KnowledgeNode } from '../app/knowledge-graph.ts'
import type { Camera, Point } from './graph-camera.ts'
import type { GraphPoint } from './knowledge-layout.ts'
import { nodeView } from './knowledge-communities.ts'

export function prepareRaster(nodes: KnowledgeNode[], edges: KnowledgeEdge[], points: GraphPoint[]) {
  const positions = new Map(points.map(point => [point.id, point]))
  const visibleEdges = edges.filter(edge => positions.has(edge.source) && positions.has(edge.target))
  const neighbors = new Map<string, Set<string>>(), incident = new Map<string, number[]>()
  visibleEdges.forEach((edge, index) => {
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      if (!neighbors.has(a)) neighbors.set(a, new Set())
      if (!incident.has(a)) incident.set(a, [])
      neighbors.get(a)!.add(b); incident.get(a)!.push(index)
    }
  })
  const names = new Map(nodes.map(node => [node.threadId, node]))
  const anchors = new Map<string, GraphPoint>()
  for (const point of points) {
    const view = nodeView(names.get(point.id)!)
    if (!view) continue
    const previous = anchors.get(view.community)
    if (view.hub || (view.role!=='core' && (!previous || point.y<previous.y || (point.y===previous.y && Math.abs(point.x-887)<Math.abs(previous.x-887))))) anchors.set(view.community,point)
  }
  const anchorIds = new Set([...anchors.values()].map(point=>point.id))
  const labelOrder = [...points].sort((a, b) => (incident.get(b.id)?.length ?? 0) - (incident.get(a.id)?.length ?? 0) || a.id.localeCompare(b.id))
  return { nodes, edges: visibleEdges, points, positions, neighbors, incident, names, labelOrder, anchorIds }
}
type RasterScene = ReturnType<typeof prepareRaster>
/** Styling is in CSS pixels, independent of graph zoom and display pixel density. */
export function graphVisualMetrics(radius: number, nodeScale: number, scale: number) {
  scale = Math.max(.01, scale)
  const radiusPx = Math.min(10, Math.max(1.25, radius * nodeScale * Math.sqrt(scale)))
  return { radius: radiusPx / scale, radiusPx, lineWidth: .55 / scale }
}
export function graphLabelLayout(scene: RasterScene, camera: Camera, width: number, height: number, enabled: boolean, focus: string, nodeScale: number) {
  const transform = rasterTransform(width, height, camera), labels: { id: string; x: number; y: number; width: number; height: number; lines: string[]; fontSize: number }[] = []
  const ordered = [...(scene.positions.has(focus) ? [scene.positions.get(focus)!] : []), ...scene.labelOrder.filter(point => point.id !== focus).sort((a,b)=>Number(scene.anchorIds.has(b.id))-Number(scene.anchorIds.has(a.id)))]
  for (const point of ordered) {
    const node = scene.names.get(point.id), view = node && nodeView(node), anchor = scene.anchorIds.has(point.id)
    if (point.id !== focus && (!enabled || (camera.zoom < 1.6 && !(anchor && (view!.role!=='core' || view!.size>=4))))) continue
    const x = transform.x + point.x * transform.scale, centerY = transform.y + point.y * transform.scale
    if (x < 12 || x > width - 12 || centerY < 0 || centerY > height - 30) continue
    const title = anchor && point.id!==focus && view ? `${view.label} · ${view.size}` : node?.title ?? '', fontSize = point.id === focus ? 13 : anchor ? 11 : 12
    const lines: string[] = []; let line = '', used = 0
    const chars = Array.from(title.slice(0, 100))
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!, size = /[\u0000-\u007f]/.test(char) ? fontSize * .58 : fontSize
      if (used + size > 168 && line) { lines.push(line.trim()); line = ''; used = 0; if (lines.length === 2) { lines[1] = lines[1]!.slice(0, -1) + '…'; break } }
      line += char; used += size
    }
    if (line && lines.length < 2) lines.push(line.trim())
    const labelWidth = Math.min(176, Math.max(...lines.map(line => Array.from(line).reduce((sum, char) => sum + (/[\u0000-\u007f]/.test(char) ? fontSize * .58 : fontSize), 0)), 10)) + 8
    const y = view && view.role!=='core' && anchor ? centerY-lines.length*16-8 : centerY + graphVisualMetrics(point.radius, nodeScale, transform.scale).radiusPx + 6, labelHeight = lines.length * 16 + 4
    if (x - labelWidth / 2 < 4 || x + labelWidth / 2 > width - 4 || y + labelHeight > height - 4) continue
    if (labels.some(label => Math.abs(label.x - x) < (label.width + labelWidth) / 2 + 10 && y < label.y + label.height + 5 && y + labelHeight + 5 > label.y)) continue
    labels.push({ id: point.id, x, y, width: labelWidth, height: labelHeight, lines, fontSize })
    if (labels.length >= (camera.zoom < 3 ? 40 : 100)) break
  }
  return labels
}
export function rasterTransform(width: number, height: number, camera: Camera, dpr = 1) {
  const base = Math.min(width / 1000, height / 540)
  return { scale: base * camera.zoom * dpr, x: ((width - 1000 * base) / 2 - camera.x * base * camera.zoom) * dpr,
    y: ((height - 540 * base) / 2 - camera.y * base * camera.zoom) * dpr }
}
export function nearestEdge(scene: RasterScene, point: Point, tolerance: number): KnowledgeEdge | undefined {
  let closest = tolerance * tolerance, result: KnowledgeEdge | undefined
  for (const edge of scene.edges) {
    const a = scene.positions.get(edge.source)!, b = scene.positions.get(edge.target)!
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const distance = (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2
    if (distance < closest) { closest = distance; result = edge }
  }
  return result
}
export interface RasterCamera { current: () => Camera; subscribe: (listener: (camera: Camera) => void) => () => void }
export interface RasterOptions { nodeScale: number; opacity: number; colorGroups: boolean; selected: string; labels?: boolean; onSelect: (id: string) => void }
const palette = ['#8ca5c4', '#b69cc6', '#94b89f', '#c3ad8c', '#94b9bb', '#ba979c']

/** One bitmap copy per camera frame; rebase at viewport/zoom boundaries or on focus changes. */
export function mountRaster(canvas: HTMLCanvasElement, svg: SVGSVGElement, camera: RasterCamera, scene: RasterScene, options: RasterOptions) {
  if (typeof Path2D === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') return () => {}
  const ctx = canvas.getContext('2d'), bitmap = document.createElement('canvas'), cache = bitmap.getContext('2d')
  if (!ctx || !cache) return () => {}
  const topics = [...new Set(scene.nodes.flatMap(node => node.topics?.map(topic => topic.label) ?? []))].sort()
  const communities = [...new Set(scene.nodes.map(node=>nodeView(node)?.community ?? ''))].sort()
  const nodes = new Map(scene.nodes.map(node => [node.threadId, node]))
  const edges = new Map<string, Path2D>(), dots = new Map<string, Path2D>()
  for (const edge of scene.edges) {
    const path = edges.get(edge.kind) ?? new Path2D(), a = scene.positions.get(edge.source)!, b = scene.positions.get(edge.target)!
    path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); edges.set(edge.kind, path)
  }
  let dotScale = -1
  function prepareDots(scale: number) {
    if (scale === dotScale) return
    dotScale = scale; dots.clear()
    for (const point of scene.points) {
    const view = nodeView(nodes.get(point.id)!)
    const color = view && view.role!=='core' ? 'peripheral' : options.colorGroups ? palette[Math.max(0,view ? communities.indexOf(view.community) : topics.indexOf(nodes.get(point.id)?.topics?.[0]?.label ?? '')) % palette.length]! : 'default'
    const path = dots.get(color) ?? new Path2D(), radius = graphVisualMetrics(point.radius, options.nodeScale, scale).radius
    path.moveTo(point.x + radius, point.y); path.arc(point.x, point.y, radius, 0, Math.PI * 2); dots.set(color, path)
  }
  }
  let width = 0, height = 0, dpr = 1, focus = options.selected, settled: ReturnType<typeof setTimeout> | undefined
  let scheduled: number | undefined, disposed = false, moving = false
  let colors = { node: '#b3b3b3', line: '#656565', accent: '#9b7bd2', text: '#b3b3b3', background: '#1e1e1e' }
  function readColors() {
    const style = getComputedStyle(svg.closest('.kg-window') ?? svg)
    colors = { node: style.getPropertyValue('--kg-node').trim() || '#909090', line: style.getPropertyValue('--kg-line').trim() || '#656565',
      accent: style.getPropertyValue('--kg-accent').trim() || '#9b7bd2', text: style.getPropertyValue('--kg-text').trim() || '#b3b3b3', background: style.getPropertyValue('--kg-bg').trim() || '#1e1e1e' }
  }
  function vectors(target: CanvasRenderingContext2D, scale: number) {
    prepareDots(scale)
    target.strokeStyle = colors.line; target.lineWidth = graphVisualMetrics(1, options.nodeScale, scale).lineWidth; target.globalAlpha = focus ? .055 : options.opacity
    target.setLineDash([])
    for (const path of edges.values()) target.stroke(path)
    target.setLineDash([]); target.globalAlpha = focus ? .4 : .95
    for (const [color, path] of dots) {
      target.globalAlpha = color==='peripheral' ? (focus ? .28 : .55) : focus ? .4 : .95
      target.fillStyle = color === 'default' || color==='peripheral' ? colors.node : color; target.fill(path)
    }
    if (focus) {
      target.globalAlpha = .65; target.strokeStyle = colors.accent; target.lineWidth = .9 / scale
      const path = new Path2D()
      for (const index of scene.incident.get(focus) ?? []) {
        const edge = scene.edges[index]!, a = scene.positions.get(edge.source)!, b = scene.positions.get(edge.target)!
        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y)
      }
      target.stroke(path)
      for (const id of [focus, ...scene.neighbors.get(focus) ?? []]) {
        const point = scene.positions.get(id); if (!point) continue
        const node = nodes.get(id), view = node && nodeView(node), index = Math.max(0, view ? communities.indexOf(view.community) : topics.indexOf(node?.topics?.[0]?.label ?? ''))
        target.globalAlpha = id === focus ? 1 : .8
        target.fillStyle = id === focus ? colors.accent : options.colorGroups ? palette[index % palette.length]! : colors.node
        target.beginPath(); target.arc(point.x, point.y, graphVisualMetrics(point.radius, options.nodeScale, scale).radius, 0, Math.PI * 2); target.fill()
      }
    }
    target.globalAlpha = 1
  }
  function clear() { ctx!.setTransform(1, 0, 0, 1, 0, 0); ctx!.clearRect(0, 0, canvas.width, canvas.height) }
  function labels(target = ctx!, offset = 0) {
    target.setTransform(dpr, 0, 0, dpr, offset * dpr, offset * dpr); target.textAlign = 'center'; target.textBaseline = 'top'
    target.lineJoin = 'round'; target.lineWidth = 3; target.strokeStyle = colors.background
    for (const label of graphLabelLayout(scene, camera.current(), width, height, options.labels ?? false, focus, options.nodeScale)) {
      target.font = `${label.fontSize}px system-ui, sans-serif`; target.globalAlpha = label.id === focus ? 1 : .72; target.fillStyle = colors.text
      label.lines.forEach((line, index) => { target.strokeText(line, label.x, label.y + index * 16); target.fillText(line, label.x, label.y + index * 16) })
    }
    target.globalAlpha = 1
  }
  function sharp() { if (!disposed) { moving = false; svg.removeAttribute('data-camera-moving'); cached() } }
  const padding = 220
  let cacheCamera = { ...camera.current() }
  function cached() {
    const value = camera.current(), scale = Math.min(width / 1000, height / 540) * value.zoom
    let ratio = value.zoom / cacheCamera.zoom
    const dx = (cacheCamera.x - value.x) * scale, dy = (cacheCamera.y - value.y) * scale
    // Rebase occasionally instead of re-rasterizing paths and text on every zoom event.
    if (ratio < .84 || ratio > 1.18 || Math.abs(dx) > padding * .75 || Math.abs(dy) > padding * .75) { rebuild(); ratio = 1 }
    const next = rasterTransform(width, height, value, dpr), prior = rasterTransform(width, height, cacheCamera, dpr)
    clear(); ctx!.imageSmoothingEnabled = ratio !== 1
    ctx!.drawImage(bitmap, Math.round(next.x - ratio * (prior.x + padding * dpr)), Math.round(next.y - ratio * (prior.y + padding * dpr)), bitmap.width * ratio, bitmap.height * ratio)
  }
  function rebuild() {
    const w = Math.ceil((width + padding * 2) * dpr), h = Math.ceil((height + padding * 2) * dpr)
    if (bitmap.width !== w || bitmap.height !== h) { bitmap.width = w; bitmap.height = h }
    cache!.setTransform(1, 0, 0, 1, 0, 0); cache!.clearRect(0, 0, w, h)
    cacheCamera = { ...camera.current() }
    const value = rasterTransform(width, height, cacheCamera, dpr)
    cache!.setTransform(value.scale, 0, 0, value.scale, value.x + padding * dpr, value.y + padding * dpr)
    vectors(cache!, value.scale / dpr)
    labels(cache!, padding)
  }
  function resize() {
    const rect = svg.getBoundingClientRect(); width = rect.width; height = rect.height
    if (!width || !height) return
    // Match native display pixels; do not force a fourfold raster workload on low-DPI displays.
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr)
    readColors(); rebuild(); sharp(); canvas.setAttribute('data-ready', ''); svg.setAttribute('data-raster', '')
  }
  const unsubscribe = camera.subscribe(() => {
    if (!moving) svg.setAttribute('data-camera-moving', '')
    svg.style.cursor = ''
    moving = true; cached(); clearTimeout(settled)
    settled = setTimeout(() => {
      moving = false; svg.removeAttribute('data-camera-moving')
      if (camera.current().zoom !== cacheCamera.zoom) { rebuild(); sharp() }
      // An unchanged-scale pan already has a sharp image including text; do not flash/rebuild it.
    }, 130)
  })
  const hover = (event: Event) => {
    const id = (event as CustomEvent<string>).detail
    if (focus === id) return
    focus = id
    if (scheduled === undefined) scheduled = requestAnimationFrame(() => { scheduled = undefined; rebuild(); if (moving) cached(); else sharp() })
  }
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('[data-node]') || event.defaultPrevented || svg.hasAttribute('data-panning')) return
    const rect = svg.getBoundingClientRect(), base = Math.min(rect.width / 1000, rect.height / 540), value = camera.current()
    const point = { x: value.x + (event.clientX - rect.left - (rect.width - 1000 * base) / 2) / base / value.zoom,
      y: value.y + (event.clientY - rect.top - (rect.height - 540 * base) / 2) / base / value.zoom }
    // During zoom, SVG hover hit testing is suspended; clicks still pick nodes precisely.
    const node = pickNode(point, base * value.zoom)
    if (node) { options.onSelect(node.id); return }
    const edge = options.selected ? undefined : nearestEdge(scene, point, 1.5 / base / value.zoom)
    options.onSelect(edge?.source ?? '')
  }
  function pickNode(point: Point, scale: number) {
    let closest = Infinity, result: GraphPoint | undefined
    for (const node of scene.points) {
      const distance = (node.x - point.x) ** 2 + (node.y - point.y) ** 2
      const radius = (graphVisualMetrics(node.radius, options.nodeScale, scale).radiusPx + 3) / scale
      if (distance < radius * radius && distance < closest) { result = node; closest = distance }
    }
    return result
  }
  let pointer: Point | undefined, hoverFrame: number | undefined
  const pointerMove = (event: PointerEvent) => {
    if (moving || svg.hasAttribute('data-panning')) return
    pointer = { x: event.clientX, y: event.clientY }
    if (hoverFrame !== undefined) return
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = undefined
      if (!pointer || moving || svg.hasAttribute('data-panning')) return
      const rect = svg.getBoundingClientRect(), value = camera.current(), scale = Math.min(rect.width / 1000, rect.height / 540) * value.zoom
      const view = rasterTransform(rect.width, rect.height, value)
      const node = pickNode({ x: (pointer.x - rect.left - view.x) / scale, y: (pointer.y - rect.top - view.y) / scale }, scale)
      hover(new CustomEvent('graphfocus', { detail: node?.id ?? options.selected }))
      svg.style.cursor = node ? 'pointer' : ''
    })
  }
  const pointerLeave = () => { pointer = undefined; hover(new CustomEvent('graphfocus', { detail: options.selected })); svg.style.cursor = '' }
  const theme = new MutationObserver(() => { readColors(); rebuild(); sharp() })
  theme.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
  observer?.observe(svg); window.addEventListener('resize', resize)
  svg.addEventListener('graphfocus', hover); svg.addEventListener('click', click)
  svg.addEventListener('pointermove', pointerMove); svg.addEventListener('pointerleave', pointerLeave)
  resize()
  return () => {
    disposed = true; unsubscribe(); clearTimeout(settled); if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    observer?.disconnect(); theme.disconnect(); window.removeEventListener('resize', resize)
    svg.removeEventListener('graphfocus', hover); svg.removeEventListener('click', click)
    svg.removeEventListener('pointermove', pointerMove); svg.removeEventListener('pointerleave', pointerLeave); svg.style.cursor = ''
    if (hoverFrame !== undefined) cancelAnimationFrame(hoverFrame)
    svg.removeAttribute('data-raster'); svg.removeAttribute('data-camera-moving'); canvas.removeAttribute('data-ready')
    bitmap.width = bitmap.height = canvas.width = canvas.height = 0
  }
}
