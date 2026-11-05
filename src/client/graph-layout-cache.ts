import type { GraphPoint, LayoutSettings } from './knowledge-layout.ts'
const KEY = 'dsh-superagent:graph-layout:v1'
const settingKey = (s: LayoutSettings) => JSON.stringify([s.charge ?? -35, s.distance ?? 60, s.center ?? .025, s.linkStrength ?? .15])
/** Derived coordinates and graph IDs only; no titles, messages or routing data. */
export function readLayoutCache(topology: string, settings: LayoutSettings, ids: string[], storage?: Pick<Storage, 'getItem'>): GraphPoint[] | null {
  try {
    const raw = (storage ?? localStorage).getItem(KEY); if (!raw) return null
    const value = JSON.parse(raw), expected = new Set(ids), found = new Set<string>()
    if (value.version !== 1 || value.topology !== topology || value.settings !== settingKey(settings) || !Array.isArray(value.points) || value.points.length !== ids.length) return null
    for (const point of value.points) {
      if (!expected.has(point.id) || found.has(point.id) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.radius) || point.radius < 0) return null
      found.add(point.id)
    }
    return value.points
  } catch { return null }
}
export function writeLayoutCache(topology: string, settings: LayoutSettings, points: GraphPoint[], storage?: Pick<Storage, 'setItem'>) {
  try {
    if (topology.length > 1500000) return
    const cache = storage ?? localStorage
    cache.setItem(KEY, JSON.stringify({ version: 1, topology, settings: settingKey(settings), points }))
  } catch { /* A disabled/full cache must not prevent the live graph from rendering. */ }
}
