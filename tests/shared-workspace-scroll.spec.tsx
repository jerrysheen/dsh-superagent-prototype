// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { attachSharedWorkspaceScroll } from '../src/client/shared-workspace-scroll.ts'
import { CodexWorkspaceSidebar } from '../src/client/codex-workspace.tsx'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'
// Vitest stubs CSS imports in jsdom; load the actual sheet for scroll-owner assertions.
const STYLES = readFileSync(join(process.cwd(), 'src/client/codex-workspace.css'), 'utf8')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); document.head.querySelectorAll('[data-shared-scroll-test]').forEach(element => element.remove()) })
function fixture() {
  const sidebar = document.createElement('div')
  sidebar.innerHTML = `<div class="native_nav">Navigation</div><div class="native_regionArea"><div class="workspace_root">
    <div class="workspace_sectionHeader"><span class="workspace_sectionLabel">工作区</span><button>Search</button></div>
    <div class="workspace_treeBody"><div class="workspace_listArea"><div class="workspace_list"><button>Native session</button></div></div><div class="workspace_fade"></div></div>
    </div></div><div class="native_footArea"><div class="native_footerActions"></div><div class="native_settingsArea">Settings</div></div>`
  document.body.append(sidebar)
  const footer = sidebar.querySelector<HTMLElement>('.native_footerActions')!
  const anchor = document.createElement('section'); footer.append(anchor)
  return { sidebar, footer, anchor }
}
it('places both workspaces under one scroll owner, leaves navigation/settings outside and restores native seats', () => {
  const style = document.createElement('style'); style.textContent = STYLES; style.setAttribute('data-shared-scroll-test', ''); document.head.append(style)
  const { sidebar, anchor } = fixture(), before = sidebar.innerHTML
  const button = sidebar.querySelector<HTMLButtonElement>('.workspace_list button')!; button.focus()
  const layout = attachSharedWorkspaceScroll(anchor, 'native-content')!
  const common = sidebar.querySelector('.cw-shared-scroll')!
  expect(common.contains(sidebar.querySelector('.native_regionArea'))).toBe(true)
  expect(common.contains(anchor)).toBe(true)
  expect(common.contains(sidebar.querySelector('.native_settingsArea'))).toBe(false)
  expect(common.contains(sidebar.querySelector('.native_nav'))).toBe(false)
  expect(document.activeElement).toBe(button)
  expect(getComputedStyle(common).overflowY).toBe('auto')
  expect(getComputedStyle(sidebar.querySelector('.workspace_list')!).overflow).toBe('visible')
  layout.setNativeCollapsed(true)
  expect(getComputedStyle(sidebar.querySelector('#native-content')!).display).toBe('none')
  layout.setNativeCollapsed(false)
  expect(getComputedStyle(sidebar.querySelector('#native-content')!).display).not.toBe('none')
  layout.dispose(); layout.dispose(); style.remove()
  expect(sidebar.innerHTML).toBe(before)
})
it('does not change an unrecognized host layout', () => {
  const anchor = document.createElement('div'); document.body.append(anchor)
  expect(attachSharedWorkspaceScroll(anchor, 'native-content')).toBeNull()
  expect(document.body.children).toHaveLength(1)
})
it('provides independent accessible toggles and cleans up the composed native layout on unmount', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('capabilities') ? { allowedThreadIds: [] }
    : { threads: [], total: 0, nextOffset: null })))
  const { sidebar, footer, anchor } = fixture(); anchor.remove()
  const original = sidebar.innerHTML, root = createRoot(footer)
  await act(async () => { root.render(<CodexWorkspaceSidebar wide store={new CodexWorkspaceStore()} open={() => {}} />) })
  const nativeToggle = sidebar.querySelector<HTMLButtonElement>('button[aria-label="展开工作区"]')!
  expect(nativeToggle).not.toBeNull()
  expect(nativeToggle.getAttribute('aria-expanded')).toBe('false')
  expect(sidebar.querySelector('.workspace_root')!.hasAttribute('data-cw-collapsed')).toBe(true)
  await act(async () => { nativeToggle.click() })
  expect(nativeToggle.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { nativeToggle.click() })
  expect(nativeToggle.getAttribute('aria-expanded')).toBe('false')
  const codexToggle = sidebar.querySelector<HTMLButtonElement>('.cw-section-toggle')!
  expect(codexToggle.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { codexToggle.click() })
  expect(sidebar.querySelector<HTMLElement>('.cw-tree')!.hidden).toBe(true)
  await act(async () => { codexToggle.click() })
  expect(nativeToggle.getAttribute('aria-expanded')).toBe('false')
  expect(sidebar.querySelector<HTMLElement>('.cw-tree')!.hidden).toBe(false)
  await act(async () => { root.unmount() })
  expect(sidebar.innerHTML).toBe(original)
})
