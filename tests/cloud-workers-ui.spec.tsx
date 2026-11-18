// @vitest-environment jsdom
/** A question draft is reviewable before the user explicitly confirms an external send. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudWorkerSection } from '../src/client/cloud-workers.tsx'
import { CloudWorkers } from '../src/app/cloud-workers.ts'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.unstubAllGlobals())

it('only sends after the confirmation button is clicked and displays submitted instead of completed', async () => {
  let state: unknown
  const send = vi.fn(async (_thread: string, _prompt: string, id: string) => ({ receiptId: id }))
  const service = new CloudWorkers({ store: { get: () => state, set: (_key: unknown, value: unknown) => { state = value } } as never,
    source: { reference: () => ({}) } as never, transport: { send } })
  const worker = service.register({ threadId: '6aeaf13e-ccac-83ec-85d6-c28959106f76', name: '通用问答' })
  const draft = service.prepare({ workerId: worker.id, question: '解释一个非项目概念' })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? await service.send(draft.id, JSON.parse(String(init.body))) : service.view())))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CloudWorkerSection />))
    expect(container.textContent).toContain('待确认发送')
    expect(send).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '确认发送到云端')!
    await act(async () => button.click())
    expect(send).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已提交 · 待回答')
    expect(container.textContent).toContain('当前接口不自动读取云端回答')
    expect(container.textContent).not.toContain('已完成')
  } finally { await act(async () => root.unmount()); container.remove() }
})


it('a user-selected ChatGPT question sends once from one direct submit, without changing Bot-authored draft approval', async () => {
  let state: unknown
  const send = vi.fn(async (_thread: string, _prompt: string, id: string) => ({ receiptId: id }))
  const service = new CloudWorkers({ store: { get: () => state, set: (_key: unknown, value: unknown) => { state = value } } as never,
    source: { reference: () => ({}) } as never, transport: { send } })
  const worker = service.register({ threadId: '6aeaf13e-ccac-83ec-85d6-c28959106f76', name: '云端问答' })
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url); paths.push(path)
    if (!init?.method || init.method === 'GET') return Response.json(service.view())
    if (path.endsWith('/prepare')) return Response.json(service.prepare(JSON.parse(String(init.body))))
    const match = /\/messages\/([^/]+)\/send$/.exec(path)
    if (match) return Response.json(await service.send(match[1]!, JSON.parse(String(init.body))))
    throw new Error('Unexpected route: ' + path)
  }))
  vi.stubGlobal('crypto', { randomUUID: () => '6ae86870-a1dc-43ec-be4b-709d2aaaa6a3' })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CloudWorkerSection />))
    const open = [...container.querySelectorAll('button')].find(node => node.textContent === '＋ 发送问题')!
    await act(async () => { open.click() })
    const select = container.querySelector<HTMLSelectElement>('form select')!
    const textarea = container.querySelector<HTMLTextAreaElement>('form textarea')!
    expect(select).toBeTruthy(); expect(textarea).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, worker.id); select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '请解释这条消息'); textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(send).toHaveBeenCalledExactlyOnceWith(worker.threadId, '请解释这条消息', '6ae86870-a1dc-43ec-be4b-709d2aaaa6a3')
    expect(paths.some(path => path.endsWith('/prepare'))).toBe(true)
    expect(paths.some(path => path.endsWith('/messages/6ae86870-a1dc-43ec-be4b-709d2aaaa6a3/send'))).toBe(true)
    expect(container.textContent).toContain('已提交 · 待回答')
  } finally { await act(async () => root.unmount()); container.remove() }
})
