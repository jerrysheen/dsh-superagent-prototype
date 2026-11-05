// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationImage } from '../src/client/conversation-image.tsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })
it('loads a scoped attachment with the management guard and releases its blob URL', async () => {
  const create = vi.fn(() => 'blob:scoped-image'), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const fetch = vi.fn(async () => new Response(new Uint8Array([137,80,78,71]), { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<ConversationImage src="/session-hub/api/codex/media?threadId=known&id=capability" alt="attached image" />))
  await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:scoped-image'))
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/codex/media?'), expect.objectContaining({ headers: { 'x-orchestrator-request': '1' } }))
  expect(host.querySelector('a')?.getAttribute('target')).toBe('_blank')
  await act(async () => root!.unmount()); root = undefined; expect(revoke).toHaveBeenCalledWith('blob:scoped-image')
})
it('shows a missing-attachment explanation rather than an empty or broken picture', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<ConversationImage src="/session-hub/api/codex/media?threadId=known&id=missing" />))
  await vi.waitFor(() => expect(host.textContent).toContain('图片不可用'))
  expect(host.querySelector('img')).toBeNull()
})
