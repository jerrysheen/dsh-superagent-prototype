// @vitest-environment jsdom
/** User-visible work facts, lazy detail reads, and exact master Session ownership. */
import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentChat, AgentChatContent } from '../src/client/agent-chat.tsx'
import { usePanel, mount, click, all, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('shows live work facts and only loads a Ticket detail when expanded', async () => {
  server.tickets.open[0]!.nativeThreadId = 'native-work'
  server.tickets.open[0]!.summary = '已完成入口梳理，正在检查交互'
  await mount()
  await click('Agent 对话')
  expect(document.querySelector('[aria-label="主 Agent 对话"]')).not.toBeNull()
  const rail = document.querySelector('[aria-label="当前任务"]')!
  expect(rail.textContent).toContain('Codex')
  expect(rail.textContent).toContain('已完成入口梳理，正在检查交互')
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(false)
  const card = rail.querySelector<HTMLButtonElement>('.sa-work-toggle')!
  expect(card.getAttribute('aria-expanded')).toBe('false')
  await click(card)
  expect(card.getAttribute('aria-expanded')).toBe('true')
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
  expect(rail.textContent).toContain('查看完整记录')
  await click(card)
  expect(document.querySelector('.sa-work-details')).toBeNull()
  expect(server.requests.every(request => request.method === 'GET')).toBe(true)
})

it('keeps human attention first and shows a truthful empty state without example tasks', async () => {
  const first = server.tickets.open[0]!
  server.tickets.open.push({ ...first, id: 'needs-you', title: '需要你确认范围', stage: 'person', action: 'blocked', updatedAt: '2020-01-01T00:00:00Z' })
  await mount()
  await click('Agent 对话')
  expect(all('.sa-work-title')[0]!.textContent).toContain('需要你确认范围')
  await click('工作与状态')
  server.tickets.open = []
  await click('Agent 对话')
  expect(text()).toContain('目前没有已登记的进行中任务')
  expect(text()).toContain('不代表原生会话没有工作')
  expect(document.querySelector('.sa-work')).toBeNull()
})

it('reports a failed list read and allows retry without creating any work', async () => {
  await mount()
  const original = globalThis.fetch
  let fail = true
  vi.stubGlobal('fetch', vi.fn((...args: Parameters<typeof fetch>) => String(args[0]).includes('/tickets?') && fail
    ? Promise.resolve(Response.json({ error: 'offline' }, { status: 503 })) : original(...args)))
  await click('Agent 对话')
  expect(text()).toContain('任务更新失败')
  fail = false
  await click('重试')
  expect(text()).not.toContain('任务更新失败')
  expect(document.querySelector('.sa-work')).not.toBeNull()
})

it('retains only the configured master, ignores a late previous open, and releases on unmount', async () => {
  let ready: () => void = () => {}
  const old = { ready: new Promise<void>(resolve => { ready = resolve }), release: vi.fn() }
  const next = { ready: Promise.resolve(), release: vi.fn() }
  const sessions = { retain: vi.fn((id: string) => id === 'master-a' ? old : next),
    list: { getSnapshot: () => ({ phase: 'ready', byId: { 'master-a': {}, 'master-b': {} } }) }, refresh: vi.fn() }
  const Provider = ({ children }: { children: ReactNode }) => <>{children}</>
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = (id: string) => <AgentChat id={id} sessions={sessions as never} SessionProvider={Provider}>
    <p>原生主对话</p>
  </AgentChat>
  try {
    await act(async () => { root.render(render('master-a')) })
    expect(container.textContent).toContain('正在连接')
    await act(async () => { root.render(render('master-b')) })
    expect(old.release).toHaveBeenCalledOnce()
    await act(async () => { ready() })
    expect(container.textContent).toBe('原生主对话')
    expect(sessions.retain.mock.calls.map(call => call[0])).toEqual(['master-a', 'master-b'])
  } finally { await act(async () => root.unmount()); container.remove() }
  expect(next.release).toHaveBeenCalledOnce()
})

it('prepares the master and refreshes a stale catalog before retaining it', async () => {
  const events: string[] = []
  let listed = false
  const reference = { ready: Promise.resolve(), release: vi.fn() }
  const sessions = {
    list: { getSnapshot: () => ({ phase: 'ready', byId: listed ? { master: {} } : {} }) },
    refresh: vi.fn(async () => { events.push('refresh'); listed = true }),
    retain: vi.fn(() => { events.push('retain'); return reference }),
  }
  const prepare = vi.fn(async () => { events.push('prepare'); return { sessionId: 'master' } })
  const Provider = ({ children }: { children: ReactNode }) => <>{children}</>
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<AgentChat id="master" sessions={sessions as never} prepare={prepare} SessionProvider={Provider}>已连接</AgentChat>) })
    expect(events).toEqual(['prepare', 'refresh', 'retain'])
    expect(container.textContent).toBe('已连接')
  } finally { await act(async () => root.unmount()); container.remove() }
  expect(reference.release).toHaveBeenCalledOnce()
})

it('does not retain a missing master and allows an explicit reconnect', async () => {
  let listed = false
  const reference = { ready: Promise.resolve(), release: vi.fn() }
  const sessions = { list: { getSnapshot: () => ({ phase: 'ready', byId: listed ? { master: {} } : {} }) },
    refresh: vi.fn(), retain: vi.fn(() => reference) }
  const Provider = ({ children }: { children: ReactNode }) => <>{children}</>
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<AgentChat id="master" sessions={sessions as never} SessionProvider={Provider}>已连接</AgentChat>) })
    expect(container.textContent).toContain('主会话尚未出现在目录中')
    expect(sessions.retain).not.toHaveBeenCalled()
    listed = true
    await act(async () => { container.querySelector('button')!.click() })
    expect(container.textContent).toBe('已连接')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('embeds the native chat factory with a fixed chat view and never submits on render', async () => {
  const renderFactorySlot = vi.fn(() => <p>Native chat and composer</p>)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<AgentChatContent {...{
      useSession: (select: (value: unknown) => unknown) => select({ blank: false, running: false, openState: 'open' }),
      useConversation: (select: (value: unknown) => unknown) => select({ activeTargets: new Set() }),
      renderFactorySlot,
    } as unknown as ComponentProps<typeof AgentChatContent>} />) })
    expect(renderFactorySlot).toHaveBeenCalledWith('conversation.content', { variant: 'embedded', phase: 'active', hero: false },
      expect.objectContaining({ slots: { views: expect.any(Function) } }))
  } finally { await act(async () => root.unmount()); container.remove() }
})
