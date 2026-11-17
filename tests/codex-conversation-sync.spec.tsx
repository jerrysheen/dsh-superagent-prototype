// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexWorkspacePage } from '../src/client/codex-workspace.tsx'
import { CodexWorkspaceStore } from '../src/client/codex-workspace-store.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const a = { provider: 'codex' as const, threadId: '01a1a0f6-353d-7581-b6dd-077563be0280', title: 'Session A', cwd: 'F:/Project/A', projectName: 'A', updatedAt: 1 }
const b = { ...a, threadId: '01a1a0f6-353d-7581-b6dd-077563be0281', title: 'Session B', cwd: 'F:/Project/B', projectName: 'B' }
let root: Root | undefined, hidden = false
const stops: (() => void)[] = []
beforeEach(() => { hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden) })
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; for (const stop of stops.splice(0)) stop()
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(store: CodexWorkspaceStore) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<CodexWorkspacePage store={store} />))
  return host
}
function responses(options: {
  transcript?: (threadId: string, url: string, init?: RequestInit) => Response | Promise<Response>
  submit?: (body: { requestId: string; threadId: string; question: string }) => Response | Promise<Response>
} = {}) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/transcript?')) return options.transcript?.(new URL(url, 'http://local').searchParams.get('threadId')!, url, init)
      ?? Response.json({ threadId: new URL(url, 'http://local').searchParams.get('threadId'), turns: [], nextCursor: null })
    if (url.endsWith('/submit')) {
      const body = JSON.parse(String(init?.body))
      return options.submit?.(body) ?? Response.json({ requestId: body.requestId, threadId: body.threadId, status: 'pending' }, { status: 202 })
    }
    if (url.includes('/requests/')) return Response.json({ status: 'pending', delivery: { transport: 'native_user_queue', receiptId: 'receipt', clientUserMessageId: 'queued-message' } })
    if (url.includes('/activity/query')) return Response.json({ sessions: [a, b].map(thread => ({
      threadId: thread.threadId, workspace: thread.cwd, state: 'idle', source: 'desktop-bridge', observedAt: new Date().toISOString(), stale: false, reason: '',
    })) })
    if (url.includes('/capabilities')) return Response.json({ allowedThreadIds: [a.threadId, b.threadId] })
    if (url.includes('/context/threads?')) return Response.json({ threads: [a, b], total: 2, nextOffset: null })
    throw Error('Unexpected request: ' + url)
  })
}
const answer = (id: string, text: string, startedAt = 1) => ({
  id, startedAt, status: 'completed', messages: [{ id: id + '-assistant', role: 'assistant' as const, text, truncated: false }],
})

it('keeps text, errors and request identities with their original conversation when switching and sending', async () => {
  const fetch = responses(); vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a)
  store.updateDraft(a.threadId, { text: 'Draft for A', error: 'Error for A', request: { body: 'original-a', requestId: 'request-a' } })
  const host = await mount(store)
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Draft for A')
  await act(async () => store.select(b))
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  expect(host.textContent).not.toContain('Error for A')
  await act(async () => store.updateDraft(b.threadId, { text: 'Question for B' }))
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  const sent = fetch.mock.calls.find(([url]) => url.endsWith('/submit'))!
  expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ threadId: b.threadId, question: 'Question for B' })
  expect(store.getSnapshot().drafts[a.threadId]).toMatchObject({ text: 'Draft for A', error: 'Error for A', request: { requestId: 'request-a' } })
  expect(store.getSnapshot().drafts[b.threadId]?.request).toBeUndefined()
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ threadId: b.threadId, status: 'pending', submitted: true })
  await act(async () => store.select(a))
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Draft for A')
})

it('rejects a mismatched acceptance receipt and does not poll or resend the rejected request', async () => {
  const fetch = responses({ submit: body => Response.json({ requestId: body.requestId, threadId: b.threadId, status: 'pending' }, { status: 202 }) })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a); store.updateDraft(a.threadId, { text: 'For A only' })
  const host = await mount(store)
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ threadId: a.threadId, submitted: false, status: 'uncertain' })
  expect(host.textContent).toContain('受理回执与发送的请求或会话不匹配')
  await store.refreshRequests()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(0)
})

it('updates externally written messages without a local send and does not reload history on every activity heartbeat', async () => {
  vi.useFakeTimers()
  let external = false
  const fetch = responses({ transcript: threadId => Response.json({ threadId,
    turns: external ? [answer('old', 'Old answer'), answer('external', 'New external answer', 2)] : [answer('old', 'Old answer')], nextCursor: null }) })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a)
  const host = await mount(store), reads = () => fetch.mock.calls.filter(([url]) => url.includes('/transcript?')).length
  expect(reads()).toBe(1); expect(store.getSnapshot().exchanges).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(reads()).toBe(1)
  external = true
  await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
  expect(reads()).toBe(2); expect(host.textContent).toContain('New external answer')
  expect(host.textContent).toContain('消息已同步')
  expect(fetch.mock.calls.filter(([url]) => url.includes('/transcript?')).every(([url]) => url.includes('limit=5'))).toBe(true)
  await act(async () => root!.unmount()); root = undefined
  const stoppedReads = reads()
  await vi.advanceTimersByTimeAsync(30000)
  expect(reads()).toBe(stoppedReads)
})

it('coalesces a slow read, aborts it on a session switch, ignores late results and suspends text polling while hidden', async () => {
  vi.useFakeTimers()
  let finishA!: (value: Response) => void, aSignal: AbortSignal | null | undefined
  const fetch = responses({ transcript: (threadId, _url, init) => threadId === a.threadId
    ? new Promise<Response>(resolve => { finishA = resolve; aSignal = init?.signal })
    : Response.json({ threadId, turns: [answer('b-turn', 'B answer')], nextCursor: null }) })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a)
  const stopA = store.watchTranscript(a.threadId); stops.push(stopA)
  const pendingA = store.loadTranscript(a.threadId, false, true)
  expect(fetch.mock.calls.filter(([url]) => url.includes('/transcript?'))).toHaveLength(1)
  store.select(b)
  const stopB = store.watchTranscript(b.threadId); stops.push(stopB)
  await store.loadTranscript(b.threadId, false, true)
  expect(aSignal?.aborted).toBe(true)
  finishA(Response.json({ threadId: a.threadId, turns: [answer('late-a', 'Late A answer')], nextCursor: null }))
  await pendingA
  expect(store.getSnapshot().transcripts[a.threadId]?.turns).toHaveLength(0)
  expect(store.getSnapshot().transcripts[a.threadId]?.loading).toBe(false)
  expect(store.getSnapshot().transcripts[b.threadId]?.turns[0]?.id).toBe('b-turn')
  hidden = true; document.dispatchEvent(new Event('visibilitychange'))
  const reads = fetch.mock.calls.filter(([url]) => url.includes('/transcript?')).length
  await vi.advanceTimersByTimeAsync(30000)
  expect(fetch.mock.calls.filter(([url]) => url.includes('/transcript?'))).toHaveLength(reads)
  expect(store.getSnapshot().transcripts[b.threadId]?.syncPaused).toBe(true)
  hidden = false; document.dispatchEvent(new Event('visibilitychange'))
  await store.loadTranscript(b.threadId, false, true)
  expect(fetch.mock.calls.filter(([url]) => url.includes('/transcript?'))).toHaveLength(reads + 1)
  stopB()
  await vi.advanceTimersByTimeAsync(30000)
  expect(fetch.mock.calls.filter(([url]) => url.includes('/transcript?'))).toHaveLength(reads + 1)
})

it('keeps loaded earlier pages and associates a queued request only through its exact native client ID', async () => {
  let updated = false, completed = false
  const queued = () => ({ id: 'native-turn', startedAt: 3, status: completed ? 'completed' : 'inProgress', messages: [
    { id: 'different-native-item-id', clientId: 'exact-client-id', role: 'user' as const, text: 'Question', truncated: false },
    { id: 'native-answer', role: 'assistant' as const, text: completed ? 'Final native answer' : '', truncated: false },
  ] })
  const fetch = responses({ transcript: (threadId, url) => Response.json({ threadId,
    turns: url.includes('cursor=') ? [answer('older', 'Earlier page', 1)]
      : updated ? [answer('latest', 'Updated latest', 2), queued()] : [answer('latest', 'Latest page', 2)],
    nextCursor: url.includes('cursor=') ? null : 'earlier-cursor' }) })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a)
  await store.loadTranscript(a.threadId); await store.loadTranscript(a.threadId, true)
  store.addExchange({ requestId: 'correct', threadId: a.threadId, question: 'Question', text: '', status: 'pending', submitted: true,
    delivery: { transport: 'native_user_queue', clientUserMessageId: 'exact-client-id' } })
  store.addExchange({ requestId: 'same-text-wrong-id', threadId: a.threadId, question: 'Question', text: '', status: 'pending', submitted: true,
    delivery: { transport: 'native_user_queue', clientUserMessageId: 'another-client-id' } })
  updated = true; await store.loadTranscript(a.threadId, false, true)
  expect(store.getSnapshot().transcripts[a.threadId]?.turns.map(turn => turn.id)).toEqual(['older', 'latest', 'native-turn'])
  expect(store.getSnapshot().transcripts[a.threadId]?.nextCursor).toBeNull()
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ status: 'pending', turnId: 'native-turn' })
  expect(store.getSnapshot().exchanges[1]?.turnId).toBeUndefined()
  completed = true; await store.loadTranscript(a.threadId, false, true)
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ status: 'completed', text: 'Final native answer' })
  expect(store.getSnapshot().exchanges[1]?.status).toBe('pending')
  expect(() => store.addExchange({ requestId: 'correct', threadId: b.threadId, question: 'Wrong thread', text: '' })).toThrow('原会话不匹配')
})

it('keeps polling an acknowledged direct request after turn binding while another session is selected', async () => {
  const requestId = '01a1a0f6-353d-7581-b6dd-077563be0282', fallback = responses()
  const fetch = vi.fn(async (input: string, init?: RequestInit) => input.endsWith('/requests/' + requestId)
    ? Response.json({ status: 'completed', reply: { threadId: a.threadId, turnId: 'bound-turn', text: 'Completed while viewing B' } })
    : fallback(input, init))
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(b)
  store.addExchange({ requestId, threadId: a.threadId, turnId: 'bound-turn', question: 'Question for A', text: '',
    status: 'pending', submitted: true })
  store.addExchange({ requestId: 'creation-only', threadId: b.threadId, turnId: 'created-turn', question: 'New session', text: '', status: 'pending' })
  await store.refreshRequests()
  expect(fetch.mock.calls.filter(([url]) => url.includes('/requests/')).map(([url]) => url))
    .toEqual(['/session-hub/api/codex/requests/' + requestId])
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ threadId: a.threadId, turnId: 'bound-turn',
    status: 'completed', text: 'Completed while viewing B' })
  expect(store.getSnapshot().exchanges[1]).toMatchObject({ requestId: 'creation-only', status: 'pending' })
  expect(store.getSnapshot().selected?.threadId).toBe(b.threadId)
})

it('replaces a stale cached turn with its newly fetched earlier-page state while preserving other turns', async () => {
  let latestMoved = false
  const fetch = responses({ transcript: (threadId, url) => Response.json({ threadId,
    turns: url.includes('cursor=') ? [answer('bound-turn', 'Completed answer', 2)]
      : latestMoved ? [answer('newer-turn', 'Newer answer', 3)]
        : [answer('older-turn', 'Earlier answer', 1), { ...answer('bound-turn', '', 2), status: 'inProgress' }],
    nextCursor: latestMoved && !url.includes('cursor=') ? 'gap-cursor' : null,
  }) })
  vi.stubGlobal('fetch', fetch)
  const store = new CodexWorkspaceStore(); store.select(a)
  await store.loadTranscript(a.threadId)
  store.addExchange({ requestId: 'bound-request', threadId: a.threadId, turnId: 'bound-turn', question: 'Question', text: '',
    status: 'pending', submitted: true })
  latestMoved = true; await store.loadTranscript(a.threadId, false, true)
  expect(store.getSnapshot().transcripts[a.threadId]?.nextCursor).toBe('gap-cursor')
  expect(store.getSnapshot().exchanges[0]?.status).toBe('pending')
  await store.loadTranscript(a.threadId, true)
  const history = store.getSnapshot().transcripts[a.threadId]!
  expect(history.turns.map(turn => turn.id)).toEqual(['older-turn', 'bound-turn', 'newer-turn'])
  expect(history.turns.find(turn => turn.id === 'bound-turn')).toMatchObject({ status: 'completed',
    messages: [expect.objectContaining({ text: 'Completed answer' })] })
  expect(history.nextCursor).toBeNull()
  expect(store.getSnapshot().exchanges[0]).toMatchObject({ status: 'completed', text: 'Completed answer' })
})

it('distinguishes accepted, queued and uncertain sends without calling acceptance completion', () => {
  vi.stubGlobal('fetch', responses())
  const store = new CodexWorkspaceStore(); store.select(a)
  const exchange = { requestId: 'queued', threadId: a.threadId, question: 'Question', text: '', status: 'pending' as const, submitted: true }
  store.addExchange(exchange)
  expect(renderToStaticMarkup(<CodexWorkspacePage store={store} />)).toContain('请求已受理，正在等待投递回执')
  store.addExchange({ ...exchange, delivery: { transport: 'desktop_queue', queueId: 'queue' } })
  expect(renderToStaticMarkup(<CodexWorkspacePage store={store} />)).toContain('已入队，等待原会话处理')
  expect(store.getSnapshot().exchanges[0]?.status).toBe('pending')
})
