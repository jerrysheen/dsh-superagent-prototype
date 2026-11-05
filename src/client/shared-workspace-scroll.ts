/** Small compatibility boundary for the pinned DSH sidebar, which has a footer slot but no workspace-extension slot. */
export interface SharedWorkspaceScroll {
  toggleMount: HTMLElement
  nativeLabel: string
  setNativeCollapsed(value: boolean): void
  dispose(): void
}
function part(root: Element, name: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[class]')].find(element => [...element.classList].some(value => value.endsWith('_' + name)))
}

/** Compose existing mounted regions; preserve the native React subtree and restore its exact seats on disposal. */
export function attachSharedWorkspaceScroll(anchor: HTMLElement, contentId: string): SharedWorkspaceScroll | null {
  let footer: HTMLElement | null = anchor.parentElement
  while (footer && ![...footer.classList].some(value => value.endsWith('_footerActions'))) footer = footer.parentElement
  const foot = footer?.parentElement, sidebar = foot?.parentElement
  if (!footer || !foot || !sidebar) return null
  const region = [...sidebar.children].find(element => [...element.classList].some(value => value.endsWith('_regionArea'))) as HTMLElement | undefined
  const heading = region && part(region, 'sectionHeader')
  const workspace = heading?.parentElement, label = heading && part(heading, 'sectionLabel')
  const list = workspace && part(workspace, 'list'), area = workspace && part(workspace, 'listArea'), tree = workspace && part(workspace, 'treeBody')
  const body = area && tree ? (area.contains(tree) ? area : tree) : area ?? tree ?? list
  if (!region || !heading || !workspace || !label || !body || !list) return null
  const document = anchor.ownerDocument
  const focused = document.activeElement instanceof HTMLElement && (region.contains(document.activeElement) || footer.contains(document.activeElement)) ? document.activeElement : null
  const regionSeat = document.createComment('native-workspace-seat'), footerSeat = document.createComment('workspace-footer-seat')
  region.before(regionSeat); footer.before(footerSeat)
  const scroll = document.createElement('div')
  scroll.className = 'cw-shared-scroll'; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '工作区与 Codex 工作区'); scroll.tabIndex = 0
  region.before(scroll); scroll.append(region, footer)
  focused?.focus({ preventScroll: true })
  const mount = document.createElement('span'); mount.className = 'cw-native-collapse-seat'; label.after(mount)
  const cleanups: (() => void)[] = []
  const mark = (element: HTMLElement, attribute: string, value: string) => {
    const previous = element.getAttribute(attribute); element.setAttribute(attribute, value)
    cleanups.push(() => previous === null ? element.removeAttribute(attribute) : element.setAttribute(attribute, previous))
  }
  mark(region, 'data-cw-native-region', '')
  mark(workspace, 'data-cw-native-workspaces', '')
  mark(label, 'data-cw-native-label', '')
  mark(body, 'data-cw-native-body', ''); mark(body, 'id', contentId)
  for (const name of ['listArea', 'treeBody', 'list', 'fade']) {
    for (const element of workspace.querySelectorAll<HTMLElement>('[class]')) {
      if ([...element.classList].some(value => value.endsWith('_' + name))) mark(element, 'data-cw-native-part', name)
    }
  }
  const previousCollapsed = workspace.getAttribute('data-cw-collapsed')
  let disposed = false
  return {
    toggleMount: mount, nativeLabel: label.textContent?.trim() || '工作区',
    setNativeCollapsed(value) { if (value) workspace.setAttribute('data-cw-collapsed', ''); else workspace.removeAttribute('data-cw-collapsed') },
    dispose() {
      if (disposed) return; disposed = true
      if (previousCollapsed === null) workspace.removeAttribute('data-cw-collapsed'); else workspace.setAttribute('data-cw-collapsed', previousCollapsed)
      for (const cleanup of cleanups.reverse()) cleanup()
      mount.remove()
      regionSeat.after(region); footerSeat.after(footer)
      scroll.remove(); regionSeat.remove(); footerSeat.remove()
    },
  }
}
