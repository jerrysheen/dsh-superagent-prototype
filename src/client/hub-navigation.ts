/** Browser-only selection shared by DSH's native panel subnav and the SuperAgent page. */
export type HubView = 'workspace' | 'tasks' | 'connections'
export interface HubNavigation {
  view: HubView
  sessionUid: string | null
  focusKey: number
}
let current: HubNavigation = { view: 'workspace', sessionUid: null, focusKey: 0 }
const listeners = new Set<() => void>()

export function getHubNavigation(): HubNavigation { return current }
export function subscribeHubNavigation(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function navigateHub(next: Partial<HubNavigation>): void {
  const value = { ...current, ...next }
  if (value.view === current.view && value.sessionUid === current.sessionUid && value.focusKey === current.focusKey) return
  current = value
  for (const listener of listeners) listener()
}
export function requestTaskDraft(): void {
  navigateHub({ view: 'workspace', sessionUid: '__new__', focusKey: current.focusKey + 1 })
}
