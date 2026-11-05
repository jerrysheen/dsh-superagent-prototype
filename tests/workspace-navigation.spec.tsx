// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationMarkdown } from '../src/client/conversation-markdown.tsx'
import { ConversationIndex } from '../src/client/conversation-index.tsx'
import { WorkspacePreview } from '../src/client/workspace-preview.tsx'
import { CodexWorkspacePage } from '../src/client/codex-workspace.tsx'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})
function mount() { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); return host }
it('opens file and web links through preview and keeps same-document anchors inside their own answer', async () => {
  const host = mount(), open = vi.fn(), scroll = vi.fn()
  vi.stubGlobal('fetch', vi.fn())
  await act(async () => root!.render(<ConversationMarkdown text={'[guide](/F:/Project/guide.md:8) [site](https://example.com) [section](#详情)\n\n## 详情'} onLink={open} />))
  const links = host.querySelectorAll('a'), heading = host.querySelector('h2')!
  heading.scrollIntoView = scroll
  await act(async () => { (links[0] as HTMLElement).click(); (links[1] as HTMLElement).click(); (links[2] as HTMLElement).click() })
  expect(open.mock.calls).toEqual([['/F:/Project/guide.md:8'], ['https://example.com']])
  expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
})
it('synchronizes the active conversation tick on scroll and navigates only the selected turn', async () => {
  const host = mount(), container = createRef<HTMLDivElement>(), list = document.createElement('div')
  Object.assign(container, { current: list }); document.body.append(list)
  list.innerHTML = '<section data-turn-id="one"></section><section data-turn-id="two"></section>'
  const sections = list.querySelectorAll('section'), scroll = vi.fn()
  let secondTop = 200
  list.getBoundingClientRect = () => ({ top: 0 } as DOMRect)
  sections[0]!.getBoundingClientRect = () => ({ top: -20 } as DOMRect)
  sections[1]!.getBoundingClientRect = () => ({ top: secondTop } as DOMRect)
  sections[1]!.scrollIntoView = scroll
  await act(async () => root!.render(<ConversationIndex container={container} items={[{ id: 'one', label: 'First question' }, { id: 'two', label: 'Second question' }]} />))
  const buttons = host.querySelectorAll('button')
  expect(buttons[0]!.getAttribute('aria-current')).toBe('location')
  await act(async () => { secondTop = 20; list.dispatchEvent(new Event('scroll')) })
  expect(buttons[1]!.getAttribute('aria-current')).toBe('location')
  await act(async () => buttons[1]!.click())
  expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
})
it('synchronizes the preview header and target line and toggles Markdown', async () => {
  const host = mount(), scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  const fetch = vi.fn(async (url: string) => Response.json({ path: 'F:/Project/' + (url.includes('next.md') ? 'next.md' : 'guide.md'), name: url.includes('next.md') ? 'next.md' : 'guide.md', text: '# Heading\nsecond line', markdown: true }))
  vi.stubGlobal('fetch', fetch)
  const close = vi.fn(), open = vi.fn()
  await act(async () => root!.render(<WorkspacePreview target={{ kind: 'file', path: 'guide.md', line: 2 }} threadId="thread-one" onClose={close} onLink={open} />))
  expect(host.querySelector('header')!.textContent).toContain('guide.md第 2 行')
  expect(host.querySelector('[data-selected]')!.getAttribute('data-line')).toBe('2')
  expect(scroll).toHaveBeenCalled()
  const toggle = [...host.querySelectorAll('button')].find(node => node.textContent === '渲染预览')!
  await act(async () => toggle.click())
  expect(host.querySelector('h1')!.textContent).toBe('Heading')
  await act(async () => root!.render(<WorkspacePreview target={{ kind: 'file', path: 'next.md' }} threadId="thread-one" onClose={close} onLink={open} />))
  expect(host.querySelector('header')!.textContent).toContain('next.md')
  expect(host.querySelector('header')!.textContent).not.toContain('guide.md')
  expect(fetch.mock.calls[0]![0]).toContain('threadId=thread-one')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click())
  expect(close).toHaveBeenCalledOnce()
})
it('opens the clicked answer file in the page and clears the preview when switching threads', async () => {
  const host = mount(), store = new CodexWorkspaceStore()
  const thread = { provider: 'codex' as const, threadId: '01a1a0f6-353d-7581-b6dd-077563be0280', title: 'Test', cwd: 'F:/Project', projectName: 'Project', updatedAt: 1 }
  store.select(thread)
  store.addExchange({ requestId: 'test', threadId: thread.threadId, question: 'Show guide', text: '[Guide](/F:/Project/guide.md)' })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/preview?')
    ? { path: 'F:/Project/guide.md', name: 'guide.md', text: '# Synthetic preview', markdown: true }
    : url.includes('/transcript?') ? { threadId: url.includes(thread.threadId) ? thread.threadId : 'other', turns: [], nextCursor: null }
    : url.includes('capabilities') ? { allowedThreadIds: [] } : { threads: [thread], total: 1, nextOffset: null })))
  await act(async () => root!.render(<CodexWorkspacePage store={store} />))
  const link = [...host.querySelectorAll('a')].find(node => node.textContent === 'Guide')!
  await act(async () => link.click())
  expect(host.querySelector('aside h1')!.textContent).toBe('Synthetic preview')
  expect(host.querySelector('aside header strong')!.textContent).toBe('guide.md')
  await act(async () => store.select({ ...thread, threadId: 'other', title: 'Other' }))
  expect(host.querySelector('aside')).toBeNull()
  expect(host.querySelector('header h1')!.textContent).toBe('Other')
})
