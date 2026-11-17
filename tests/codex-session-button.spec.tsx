// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexSessionButton } from '../src/client/codex-session-button.tsx'

const panel = vi.hoisted(() => ({ openCodex: vi.fn(), notify: vi.fn() }))
vi.mock('../src/client/provider.tsx', () => ({ usePanel: () => panel }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const id = '01a1a0f6-353d-7581-b6dd-077563be0280'
const other = '01a1a0f6-353d-7581-b6dd-077563be0281'
const thread = { provider: 'codex', threadId: id, title: 'Actual bound session', cwd: 'F:\\Project', projectName: 'Project', updatedAt: 1 }
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(threadId = id) { await act(async () => root.render(<CodexSessionButton threadId={threadId} />)) }

it('opens the exact indexed native conversation inside DSH using metadata only', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ threads: [{ ...thread, threadId: other, title: 'Similar title' }, thread] }))
  vi.stubGlobal('fetch', fetch)
  await render()
  await act(async () => container.querySelector('button')!.click())
  expect(panel.openCodex).toHaveBeenCalledExactlyOnceWith(thread)
  expect(fetch).toHaveBeenCalledOnce()
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/context/threads?query=' + id)
  expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBeUndefined()
  expect(panel.notify).not.toHaveBeenCalled()
})
it('refuses a missing exact binding instead of opening a similar session or sending a new request', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ threads: [{ ...thread, threadId: other }] })))
  await render()
  await act(async () => container.querySelector('button')!.click())
  expect(panel.openCodex).not.toHaveBeenCalled()
  expect(panel.notify).toHaveBeenCalledWith(expect.stringContaining('尚未出现在当前目录'))
})
it('ignores a late lookup after the selected work changes', async () => {
  let finish: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  await render()
  await act(async () => container.querySelector('button')!.click())
  await render(other)
  await act(async () => { finish(Response.json({ threads: [thread] })) })
  expect(panel.openCodex).not.toHaveBeenCalled()
  expect(panel.notify).not.toHaveBeenCalled()
})
