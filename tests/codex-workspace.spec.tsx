import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'
import { CodexWorkspacePage, CodexWorkspaceSidebar } from '../src/client/codex-workspace.tsx'
const thread = { provider: 'codex' as const, threadId: '01a1a0f6-353d-7581-b6dd-077563be0280', title: 'Test thread', cwd: 'F:\\Projects\\A', projectName: 'A', updatedAt: 1760000020 }
afterEach(() => vi.unstubAllGlobals())
it('groups metadata in the sidebar, opens the original technical ID and keeps sending off by default', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('capabilities') ? Response.json({ allowedThreadIds: [] })
    : Response.json({ threads: [thread], total: 1, nextOffset: null }))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); await store.refresh(); store.select(thread)
  const sidebar = renderToStaticMarkup(createElement(CodexWorkspaceSidebar, { wide: true, store, open: () => {} }))
  expect(sidebar).toContain('新建提问'); expect(sidebar).toContain('在 A 新建提问'); expect(sidebar).toContain('新建云端提问');
  expect(sidebar).toContain('Codex 工作区'); expect(sidebar).toContain('Test thread')
  expect(sidebar).toContain('href="codex://threads/' + thread.threadId + '"')
  expect(sidebar).toContain('在 Codex 打开：Test thread')
  expect(renderToStaticMarkup(createElement(CodexWorkspaceSidebar, { wide: false, store, open: () => {} }))).toBe('')
  const html = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(html).not.toContain('搜索标题、项目或线程 ID')
  expect(html).not.toContain('定位目标')
  expect(html).not.toContain('找到要继续的工作')
  expect(html).toContain('codex://threads/' + thread.threadId)
  expect(html).toContain('此会话未启用续聊')
  expect(html).toContain('disabled')
  expect(fetch.mock.calls.every(([url]) => !url.includes('/ask'))).toBe(true)
})
it('preserves old metadata and reports an unavailable API without pretending it is an empty successful sync', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } })))
  const store = new CodexWorkspaceStore(); await store.refresh()
  expect(store.getSnapshot().error).toContain('接口尚未就绪')
  expect(store.getSnapshot().loading).toBe(false)
})
it('keeps multiple DSH exchanges across page mounts and does not show another thread\'s replies', () => {
  const store = new CodexWorkspaceStore(); store.select(thread)
  store.addExchange({ requestId: 'one', threadId: thread.threadId, question: 'first question', text: 'first answer' })
  store.addExchange({ requestId: 'two', threadId: thread.threadId, question: 'follow up', text: 'second answer' })
  store.addExchange({ requestId: 'two', threadId: thread.threadId, question: 'follow up', text: 'second answer' })
  store.addExchange({ requestId: 'other', threadId: 'other-thread', question: 'elsewhere', text: 'answer from another thread' })
  expect(store.getSnapshot().exchanges).toHaveLength(3)
  const html = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(html).toContain('first answer'); expect(html).toContain('second answer')
  expect(html).not.toContain('answer from another thread')
})
it('loads selected history only on request, merges older pages and does not duplicate live replies', async () => {
  const turn = { id: 'turn-new', status: 'completed', startedAt: 20, messages: [{ id: 'a', role: 'assistant', text: 'existing reply', truncated: false }] }
  const fetch = vi.fn(async (url: string) => Response.json({ threadId: thread.threadId,
    turns: url.includes('cursor=') ? [{ ...turn, id: 'turn-old', startedAt: 10 }] : [turn], nextCursor: url.includes('cursor=') ? null : 'previous' }))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(thread)
  expect(fetch.mock.calls.every(([url]) => !url.includes('/transcript'))).toBe(true)
  await store.loadTranscript(thread.threadId)
  await store.loadTranscript(thread.threadId, true)
  expect(store.getSnapshot().transcripts[thread.threadId]?.turns.map(item => item.id)).toEqual(['turn-old', 'turn-new'])
  store.addExchange({ requestId: 'live', threadId: thread.threadId, turnId: 'turn-new', question: 'duplicate', text: 'duplicate reply' })
  const html = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(html).toContain('existing reply'); expect(html).not.toContain('duplicate reply')
})
it('shows live status beside the session and selected conversation without sending a question', async () => {
  const fetch = vi.fn(async (_url: string) => Response.json({ sessions: [{ threadId: thread.threadId, workspace: thread.cwd,
    state: 'running', source: 'desktop-bridge', observedAt: new Date().toISOString(), stale: false, reason: '' }] }))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(thread); await store.refreshActivities()
  const page = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(page).toContain('进行中'); expect(page).toContain('状态观测时间')
  expect(page).toContain('cw-activity-spinner'); expect(page).not.toContain('>进行中<')
  expect(page).not.toContain('定位目标')
  expect(fetch.mock.calls.every(([url]) => !url.includes('/ask') && !url.includes('/work'))).toBe(true)
})
it('keeps last observed activity visible during a temporary connection gap with a timestamp hint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [{ threadId: thread.threadId, workspace: thread.cwd,
    state: 'running', source: 'desktop-bridge', observedAt: new Date(Date.now() - 70000).toISOString(), stale: true, reason: '' }] })))
  const store = new CodexWorkspaceStore(); store.select(thread); await store.refreshActivities()
  const page = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(page).not.toContain('状态未知'); expect(page).toContain('保留上次观测')
  expect(page).not.toContain('data-state="idle"')
  expect(page).toContain('cw-activity-spinner"')
})
it('retains a confirmed running circle across API errors and initial unknown replies after service restart', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ sessions: [{ threadId: thread.threadId, workspace: thread.cwd,
    state: 'running', source: 'desktop-bridge', observedAt: new Date().toISOString(), stale: false, reason: '' }] }))
    .mockRejectedValueOnce(Error('Offline')).mockResolvedValueOnce(Response.json({ sessions: [{ threadId: thread.threadId,
      state: 'unknown', source: 'unavailable', observedAt: new Date().toISOString(), stale: false }] }))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore()
  // Selection automatically queries the selected native ID.
  store.select(thread); await vi.waitFor(() => expect(store.getSnapshot().activities[thread.threadId]?.state).toBe('running'))
  await store.refreshActivities(); await store.refreshActivities()
  expect(store.getSnapshot().activities[thread.threadId]).toMatchObject({ state: 'running', stale: true })
  expect(renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))).toContain('cw-activity-spinner"')
})

it('immediately displays an outgoing question and images, then replaces the pending reply without duplicating the message', () => {
  const store = new CodexWorkspaceStore()
  const exchange = { requestId: 'outgoing-1', threadId: thread.threadId, question: 'New question', text: '', images: [{ src: '/pending-image.png', alt: 'attachment' }] }
  // Select through the public API; the activity request is irrelevant to this rendering test.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [] })))
  store.select(thread)
  store.addExchange({ ...exchange, status: 'pending' })
  const pending = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(pending).toContain('New question')
  expect(pending).toContain('/pending-image.png')
  expect(pending).toContain('aria-busy="true"')
  const startedAt = store.getSnapshot().exchanges[0]!.startedAt
  store.addExchange({ ...exchange, status: 'completed', turnId: 'real-turn', text: 'Real answer' })
  expect(store.getSnapshot().exchanges).toHaveLength(1)
  expect(store.getSnapshot().exchanges[0]!.startedAt).toBe(startedAt)
  const completed = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(completed).toContain('Real answer')
  expect(completed).not.toContain('aria-busy="true"')
})
it('keeps an uncertain outgoing message and its attachment visible without resending', () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [] })))
  const store = new CodexWorkspaceStore(); store.select(thread)
  store.addExchange({ requestId: 'uncertain', threadId: thread.threadId, question: 'Keep this question', text: '', status: 'uncertain', error: 'Check original conversation before retrying' })
  const page = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(page).toContain('Keep this question')
  expect(page).toContain('Check original conversation before retrying')
})

it('opens a blank main conversation for the chosen project and keeps the sidebar free of forms', () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [] })))
  const store = new CodexWorkspaceStore()
  store.newConversation(thread.cwd, thread.projectName)
  expect(store.getSnapshot().selected).toBeNull()
  expect(store.getSnapshot().newTarget).toEqual({ cwd: thread.cwd, projectName: 'A' })
  const sidebar = renderToStaticMarkup(createElement(CodexWorkspaceSidebar, { wide: true, store, open: () => {} }))
  expect(sidebar).not.toContain('<form')
  expect(sidebar).not.toContain('<textarea')
  const main = renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))
  expect(main).toContain('新会话')
  expect(main).toContain('向新 Codex 会话提问')
  expect(main).toContain(thread.cwd)
  store.select(thread)
  expect(store.getSnapshot().newTarget).toBeUndefined()
})

it('heartbeat completes a submitted question and restores sending without a long HTTP response', async () => {
  const fetch = vi.fn(async () => Response.json({ status: 'completed', reply: { threadId: thread.threadId, turnId: 'heartbeat-turn', text: 'Heartbeat answer' } }))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore()
  store.newConversation(thread.cwd, thread.projectName)
  store.addExchange({ requestId: 'heartbeat', threadId: thread.threadId, question: 'Question', text: '', status: 'pending', submitted: true })
  await store.refreshRequests()
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ status: 'completed', turnId: 'heartbeat-turn', text: 'Heartbeat answer' })
  store.select(thread)
  expect(renderToStaticMarkup(createElement(CodexWorkspacePage, { store }))).not.toContain('等待 Codex 回复…')
})
it('does not poll an unacknowledged submission or mark network errors as completion', async () => {
  const fetch = vi.fn(async () => { throw Error('offline') })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore()
  const exchange = { requestId: 'offline', threadId: thread.threadId, question: 'Question', text: '', status: 'pending' as const }
  store.addExchange({ ...exchange, submitted: false })
  await store.refreshRequests(); expect(fetch).not.toHaveBeenCalled()
  store.addExchange({ ...exchange, submitted: true })
  await store.refreshRequests(); expect(fetch).toHaveBeenCalledOnce()
  expect(store.getSnapshot().exchanges[0]!.status).toBe('pending')
})
