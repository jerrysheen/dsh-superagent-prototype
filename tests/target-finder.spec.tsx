// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TargetFinder } from '../src/client/target-finder.tsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const card = (uid: string) => ({ uid, title: 'WASM 内存 ' + uid, projectName: 'Example', workspace: 'f:\\example',
  threadId: uid, kind: 'codex', fingerprint: 'a'.repeat(64), summary: '代码内存膨胀' })
let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function render(result: object, gate?: Promise<void>) {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (gate) await gate
    return url.endsWith('/select') ? Response.json({ target: { kind: 'session', card: card(JSON.parse(String(options?.body)).uid), binding: { executable: false } } })
      : Response.json(result)
  })
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); cleanup = () => { act(() => root.unmount()); container.remove() }
  await act(async () => root.render(<TargetFinder />))
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '继续那个内存问题')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  return { container, fetch }
}
it('shows a unique target directly without a confirmation choice or an automatic send', async () => {
  const { container, fetch } = await render({ action: 'selected', reason: '唯一主题匹配', target: { kind: 'session', card: card('one') }, candidates: [], projects: [] })
  expect(container.textContent).toContain('WASM 内存 one')
  expect(container.querySelector('a')?.href).toBe('codex://threads/one')
  expect(fetch).toHaveBeenCalledTimes(1)
})
async function edit(container: HTMLElement, value: string) {
  await act(async () => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('invalidates the old target when the query changes', async () => {
  const { container } = await render({ action: 'selected', reason: '匹配', target: { kind: 'session', card: { ...card('engine-one'), kind: 'engine' },
    binding: { kind: 'engine-ticket', workspace: 'f:\\example', workId: 'old-work' } }, candidates: [], projects: [] })
  expect(container.textContent).toContain('继续这个工作')
  await edit(container, '新开一条独立会话做另一个问题')
  expect(container.textContent).not.toContain('继续这个工作')
  expect(container.textContent).not.toContain('WASM 内存 engine-one')
})
it('does not restore an old asynchronous lookup after the user edits its query', async () => {
  const gate = Promise.withResolvers<void>()
  const { container } = await render({ action: 'selected', reason: '旧请求', target: { kind: 'session', card: card('old') }, candidates: [], projects: [] }, gate.promise)
  await edit(container, '另一个新任务')
  await act(async () => { gate.resolve() })
  expect(container.textContent).not.toContain('WASM 内存 old')
})
it('offers relevant choices and revalidates the chosen fingerprint without submitting work', async () => {
  const { container, fetch } = await render({ action: 'needs_confirmation', reason: '两项相近工作', target: null, candidates: [card('one'), card('two')], projects: [] })
  const choices = [...container.querySelectorAll('button')].filter(button => button.textContent?.includes('WASM'))
  expect(choices).toHaveLength(2)
  await act(async () => { choices[1]!.click() })
  expect(container.querySelector('a')?.href).toBe('codex://threads/two')
  expect(fetch.mock.calls[1]?.[0]).toContain('/context/select')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ uid: 'two', fingerprint: 'a'.repeat(64) })
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/work') || url.includes('/codex/ask'))).toBe(false)
})
