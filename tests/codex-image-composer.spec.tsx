// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'
import { CodexWorkspacePage, CodexWorkspaceSidebar } from '../src/client/codex-workspace.tsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })
const id = '01a1a0f6-353d-7581-b6dd-077563be0280', imageId = '01a1a0f6-353d-7581-b6dd-077563be0283'
const thread = { provider: 'codex' as const, threadId: id, title: 'selected', cwd: 'F:\\Repo', projectName: 'Repo', updatedAt: 5 }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
function mount() { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); return host }
it('pastes an image into a new conversation and sends image-only content through create', async () => {
  const calls: { url: string; body?: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body })
    if (url.endsWith('/sidebar/create')) return Response.json({ threadId: id, turnId: 'new-image-turn', status: 'accepted' })
    if (url.includes('/transcript')) return Response.json({ threadId: id, turns: [], nextCursor: null })
    if (url.includes('/capabilities')) return Response.json({ allowedThreadIds: [id] })
    if (url.includes('/activity/')) return Response.json({ sessions: [] })
    return Response.json({ threads: [thread], total: 1, nextOffset: null })
  }))
  const store = new CodexWorkspaceStore(); store.newConversation(thread.cwd, thread.projectName)
  const host = mount(); await act(async () => root!.render(<CodexWorkspacePage store={store} />))
  const file = new File([Uint8Array.from(atob(png.split(',')[1]!), character => character.charCodeAt(0))], 'synthetic.png', { type: 'image/png' })
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
  await act(async () => host.querySelector('textarea')!.dispatchEvent(paste))
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 30)) })
  expect(host.querySelector('.cw-composer-images img')).not.toBeNull()
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(calls.find(call => call.url.endsWith('/sidebar/create'))?.body).toMatchObject({ text: '', images: [png], target: 'codex', cwd: thread.cwd })
  expect(store.getSnapshot().exchanges[0]?.images).toHaveLength(1)
})
it('uploads and previews an image, then sends a typed attachment token to the exact selected session', async () => {
  const calls: { url: string; body?: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body })
    if (url.includes('/capabilities')) return Response.json({ allowedThreadIds: [id] })
    if (url.includes('/activity/')) return Response.json({ sessions: [] })
    if (url.includes('/transcript')) return Response.json({ threadId: id, turns: [], nextCursor: null })
    if (url.includes('/upload')) return Response.json({ id: imageId, src: png })
    if (url.endsWith('/submit')) return Response.json({ requestId: imageId, status: 'pending' })
    if (url.includes('/requests/')) return Response.json({ status: 'pending' })
    return Response.json({ threads: [thread], total: 1, nextOffset: null })
  }))
  const store = new CodexWorkspaceStore(); await store.refresh(); store.select(thread); const host = mount()
  await act(async () => root!.render(<CodexWorkspacePage store={store} />))
  const picker = host.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File([Uint8Array.from(atob(png.split(',')[1]!), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' })] })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await vi.waitFor(() => expect(host.querySelector('.cw-composer-images img')).not.toBeNull())
  expect(calls.find(call => call.url.endsWith('/upload'))?.body.threadId).toBe(id)
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(calls.find(call => call.url.endsWith('/submit'))?.body).toMatchObject({ threadId: id, question: '', images: [imageId], confirmed: true })
  expect(store.getSnapshot().exchanges[0]?.images).toHaveLength(1)
})
it('puts cross-project recent sessions above projects and opens the original session identity', async () => {
  const rows = [thread, { ...thread, threadId: imageId, title: 'newest', projectName: 'Other', cwd: 'F:\\Other', updatedAt: 10 }]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/capabilities') ? Response.json({ allowedThreadIds: [] }) : url.includes('/activity/') ? Response.json({ sessions: [] }) : Response.json({ threads: rows, total: 2, nextOffset: null })))
  const store = new CodexWorkspaceStore(); await store.refresh(); const open = vi.fn(), host = mount()
  await act(async () => root!.render(<CodexWorkspaceSidebar wide store={store} open={open} />))
  const recent = host.querySelector('.cw-recent')!
  expect(recent.querySelector('.cw-session-main')?.getAttribute('title')).toContain('newest')
  await act(async () => (recent.querySelector('.cw-session-main') as HTMLButtonElement).click())
  expect(open).toHaveBeenCalledWith(rows[1])
})
