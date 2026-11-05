import { useEffect, useMemo, useRef, type RefObject } from 'react'
export interface Camera { x: number; y: number; zoom: number }
export interface Point { x: number; y: number }
export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 }

/** SVG xMidYMid/meet coordinates, including the padding on wide/tall viewports. */
export function viewportPoint(client: Point, rect: { left: number; top: number; width: number; height: number }): Point {
  const scale = Math.max(.0001, Math.min(rect.width / 1000, rect.height / 540))
  return { x: (client.x - rect.left - (rect.width - 1000 * scale) / 2) / scale,
    y: (client.y - rect.top - (rect.height - 540 * scale) / 2) / scale }
}
export function zoomAt(camera: Camera, factor: number, anchor: Point): Camera {
  const zoom = Math.max(.15, Math.min(20, camera.zoom * factor))
  return { x: camera.x + anchor.x / camera.zoom - anchor.x / zoom,
    y: camera.y + anchor.y / camera.zoom - anchor.y / zoom, zoom }
}

/** Camera input never updates React state or reconciles graph marks. */
export function useGraphCamera(svg: RefObject<SVGSVGElement>, scene: RefObject<SVGGElement>) {
  const camera = useRef<Camera>({ ...DEFAULT_CAMERA }), frame = useRef<number>()
  const api = useMemo(() => {
    const listeners = new Set<(camera: Camera) => void>()
    const update = (value: Camera) => {
      camera.current = value
      if (frame.current !== undefined) return
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined
        const value = camera.current
        scene.current?.setAttribute('transform', `translate(${-value.x * value.zoom} ${-value.y * value.zoom}) scale(${value.zoom})`)
        for (const listener of listeners) listener(value)
      })
    }
    return { zoom: (factor: number) => update(zoomAt(camera.current, factor, { x: 500, y: 270 })),
      reset: () => update({ ...DEFAULT_CAMERA }), update, current: () => camera.current,
      subscribe: (listener: (camera: Camera) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  }, [scene])
  useEffect(() => {
    const element = svg.current
    if (!element) return
    let drag: { start: Point; camera: Camera; moved: boolean; pointer: number; rect: DOMRect } | undefined
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)
      if (!delta) return
      api.update(zoomAt(camera.current, Math.exp(-Math.max(-500, Math.min(500, delta)) * .002), viewportPoint({ x: event.clientX, y: event.clientY }, rect)))
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 1) return
      event.preventDefault()
      drag = { start: { x: event.clientX, y: event.clientY }, camera: { ...camera.current }, moved: false, pointer: event.pointerId, rect: element.getBoundingClientRect() }
    }
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointer !== event.pointerId) return
      if (!drag.moved && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 4) return
      if (!drag.moved) { drag.moved = true; element.setPointerCapture?.(event.pointerId); element.setAttribute('data-panning', '') }
      const start = viewportPoint(drag.start, drag.rect), now = viewportPoint({ x: event.clientX, y: event.clientY }, drag.rect)
      api.update({ ...drag.camera, x: drag.camera.x - (now.x - start.x) / drag.camera.zoom, y: drag.camera.y - (now.y - start.y) / drag.camera.zoom })
    }
    const up = (event: PointerEvent) => {
      if (!drag || (event.type === 'pointerup' && event.button !== 1)) return
      const pointer = drag.pointer; drag = undefined; element.removeAttribute('data-panning')
      if (element.hasPointerCapture?.(pointer)) element.releasePointerCapture?.(pointer)
    }
    const middle = (event: MouseEvent) => { if (event.button === 1) event.preventDefault() }
    const click = (event: MouseEvent) => { if (event.button === 1) { event.preventDefault(); event.stopImmediatePropagation() } }
    const key = (event: KeyboardEvent) => {
      if (event.target !== element) return
      if (event.key === '+' || event.key === '=') { event.preventDefault(); api.zoom(1.2) }
      if (event.key === '-') { event.preventDefault(); api.zoom(1 / 1.2) }
    }
    element.addEventListener('wheel', wheel, { passive: false }); element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up)
    window.addEventListener('pointerup', up)
    element.addEventListener('click', click, true); element.addEventListener('keydown', key)
    element.addEventListener('mousedown', middle); element.addEventListener('auxclick', middle)
    return () => {
      element.removeEventListener('wheel', wheel); element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); element.removeEventListener('click', click, true); element.removeEventListener('keydown', key)
      window.removeEventListener('pointerup', up)
      element.removeEventListener('mousedown', middle); element.removeEventListener('auxclick', middle)
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    }
  }, [api, svg])
  return api
}
