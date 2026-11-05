// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ManagedWorkButton } from '../src/client/managed-work.tsx'
import { usePanel, mount, click, text, type, field } from './fixtures/panel.tsx'

usePanel()

it('shows the exact work, target and read-only permission before explicit confirmation', async () => {
  const originalFetch = globalThis.fetch, calls: { path: string; body?: any }[] = []
  const proposal = { id: 'draft', token: 'a'.repeat(64), state: 'draft', mode: 'continue', workspace: 'F:\\Project', instruction: '只读核对原问题', targetTitle: 'Original task', executor: 'codex', permission: 'read-only' }
  let submitted = false
  vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/state')) return originalFetch(url, init).then(async response => Response.json({ ...await response.json(), coordinationMode: 'sessions', sessionExecution: true }))
    if (!String(url).includes('/managed-work')) return originalFetch(url, init)
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (String(url).endsWith('/confirm')) { submitted = true; return Promise.resolve(Response.json({ state: 'submitted' })) }
    return Promise.resolve(Response.json({ options: { enabled: true, paused: true, workspaces: ['F:\\Project'] }, proposals: submitted ? [] : [proposal], works: [] }))
  }))
  await mount(); await click('Agent 对话')
  expect(text()).toContain('只读核对原问题'); expect(text()).toContain('Original task'); expect(text()).toContain('只读')
  expect(calls.every(call => !call.body)).toBe(true)
  await click('确认并启动只读工作')
  expect(calls.find(call => call.path.endsWith('/confirm'))?.body).toEqual({ id: 'draft', token: proposal.token, confirmed: true, startExecution: true, permission: 'read-only' })
})

it('offers an explicit native-session adoption action without sending a message or admitting a ticket', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ state: 'draft' })), onPrepared = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(<ManagedWorkButton workspace="F:\\Project" targetUid="codex:one" instruction="接着核对" onPrepared={onPrepared} />))
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => container.querySelector('button')!.click())
    expect(fetch.mock.calls[0]?.[0]).toBe('/session-hub/api/managed-work/prepare')
    expect(onPrepared).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('lets the user choose project write access on the card and includes explicit authorization only at confirmation', async () => {
  const originalFetch = globalThis.fetch, calls: { path: string; body?: any }[] = []
  const proposal = { id: 'draft', token: 'b'.repeat(64), state: 'draft', mode: 'new', workspace: 'F:\\Project', instruction: '修复入口', executor: 'codex', permission: 'read-only' }
  vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/state')) return originalFetch(url, init).then(async response => Response.json({ ...await response.json(), coordinationMode: 'sessions', sessionExecution: true }))
    if (!String(url).includes('/managed-work')) return originalFetch(url, init)
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Promise.resolve(Response.json({ options: { enabled: true, paused: false, workspaces: ['F:\\Project'] }, proposals: [proposal], works: [] }))
  }))
  await mount(); await click('Agent 对话')
  await type(field<HTMLSelectElement>('工作执行权限'), 'workspace-write')
  expect(calls.every(call => !call.body)).toBe(true)
  await click('确认提交工程读写工作')
  expect(calls.find(call => call.path.endsWith('/confirm'))?.body).toMatchObject({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE', confirmed: true })
})
it('explains desktop permission ownership and confirms desktop execution explicitly', async () => {
  const originalFetch = globalThis.fetch, calls: any[] = []
  const proposal = { id: 'desktop-draft', token: 'c'.repeat(64), state: 'draft', mode: 'new', transport: 'desktop', workspace: 'F:\\Project', instruction: '修复桌面工作区入口', executor: 'codex', permission: 'workspace-write' }
  vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/state')) return originalFetch(url, init).then(async response => Response.json({ ...await response.json(), coordinationMode: 'sessions', sessionExecution: true }))
    if (!String(url).includes('/managed-work')) return originalFetch(url, init)
    if (init?.body) calls.push(JSON.parse(String(init.body)))
    return Promise.resolve(Response.json({ options: { enabled: true, paused: false, workspaces: ['F:\\Project'] }, proposals: [proposal], works: [] }))
  }))
  await mount(); await click('Agent 对话')
  expect(text()).toContain('桌面对应 workspace'); expect(text()).toContain('DSH 不覆盖')
  expect(calls).toHaveLength(0)
  await click('确认在桌面执行（沿用桌面权限）')
  expect(calls[0]).toMatchObject({ permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE', desktopAuthorization: 'EXPLICIT_DESKTOP_PERMISSIONS', confirmed: true })
})
