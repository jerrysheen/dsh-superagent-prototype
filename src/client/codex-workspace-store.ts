/** One plugin-owned metadata view shared by its sidebar and main panel. */
export interface CodexThread { provider: 'codex'; threadId: string; title: string; cwd: string; projectName: string; updatedAt: number }
import type { CodexTranscript } from '../app/codex-transcript.ts'
import type { SessionActivity } from '../app/session-activity.ts'
export interface CodexDelivery { transport: 'desktop_queue' | 'desktop_app' | 'native_image_queue' | 'native_user_queue'; queueId?: string; receiptId?: string; clientUserMessageId?: string }
export interface CodexExchange { requestId: string; threadId: string; question: string; text: string; submitted?: boolean; status?: 'pending' | 'completed' | 'uncertain'; error?: string; turnId?: string; startedAt?: number; images?: { src: string; alt: string }[]; delivery?: CodexDelivery }
export interface TranscriptState extends CodexTranscript { loaded: boolean; loading: boolean; error: string; lastSyncedAt?: number; syncPaused?: boolean }
export interface CodexDraft { text: string; error: string; request?: { body: string; requestId: string } }
export interface CodexWorkspaceState {
  threads: CodexThread[]; selected: CodexThread | null; total: number; nextOffset: number | null;
  loading: boolean; error: string; query: string; allowedThreadIds: string[]; exchanges: CodexExchange[]; transcripts: Record<string, TranscriptState>;
  drafts: Record<string, CodexDraft>;
  newTarget?: { cwd: string; projectName: string };
  activities: Record<string, SessionActivity>
}
const hidden = () => typeof document !== 'undefined' && document.hidden
/** Holds browser-side native question state independently of Engine task records. */
export class CodexWorkspaceStore {
  private state: CodexWorkspaceState = { threads: [], selected: null, total: 0, nextOffset: null, loading: true, error: '', query: '', allowedThreadIds: [], exchanges: [], transcripts: {}, drafts: {}, activities: {} }
  private listeners = new Set<() => void>()
  private request?: AbortController
  private historyRequest?: { threadId: string; more: boolean; controller: AbortController; promise: Promise<void> }
  private transcriptWatcher?: { threadId: string; stop(): void }
  private viewers = 0
  private timer?: ReturnType<typeof setInterval>
  private requestTimer?: ReturnType<typeof setInterval>
  private activityTimer?: ReturnType<typeof setInterval>
  private activityRequest?: AbortController
  private requestsAbort?: AbortController
  private visibilityListener?: () => void
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(next: Partial<CodexWorkspaceState>) { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener() }
  newConversation = (cwd: string, projectName: string) => {
    this.transcriptWatcher?.stop()
    this.update({ selected: null, newTarget: { cwd, projectName } })
  }
  select = (selected: CodexThread) => {
    if (this.state.selected?.threadId !== selected.threadId) this.transcriptWatcher?.stop()
    this.update({ selected, newTarget: undefined }); void this.refreshActivities()
  }
  updateDraft(threadId: string, next: Partial<CodexDraft>) {
    this.update({ drafts: { ...this.state.drafts, [threadId]: { text: '', error: '', ...this.state.drafts[threadId], ...next } } })
  }
  clearDraftRequest(threadId: string, requestId: string) {
    if (this.state.drafts[threadId]?.request?.requestId === requestId) this.updateDraft(threadId, { request: undefined })
  }
  private activityPass?: Promise<void>
  refreshActivities(): Promise<void> { return this.activityPass ??= this.pollActivities().finally(() => { this.activityPass = undefined }) }
  private async pollActivities() {
    const threadIds = [...new Set([this.state.selected?.threadId, ...this.state.threads.map(t => t.threadId)].filter((id): id is string => !!id))].slice(0, 100)
    if (!threadIds.length || hidden()) return
    this.activityRequest?.abort(); const request = this.activityRequest = new AbortController()
    try {
      const response = await fetch('/session-hub/api/activity/query', { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ threadIds }), signal: request.signal })
      if (!response.ok) throw Error('Activity unavailable')
      const value = await response.json() as { sessions: SessionActivity[] }
      if (!Array.isArray(value.sessions)) throw Error('Invalid activity response')
      const allowed = new Set(threadIds), activities = { ...this.state.activities }
      for (const item of value.sessions) if (allowed.has(item.threadId) && Number.isFinite(Date.parse(item.observedAt)) && ['running', 'idle', 'waiting_user', 'failed', 'unknown'].includes(item.state)) {
        activities[item.threadId] = item.state === 'unknown' && activities[item.threadId]
          ? { ...activities[item.threadId]!, stale: true } : item
      }
      if (!request.signal.aborted) this.update({ activities })
    } catch { if (!request.signal.aborted) this.update({ activities: Object.fromEntries(Object.entries(this.state.activities).map(([id, value]) => [id, { ...value, stale: true }])) }) }
  }
  addExchange(exchange: CodexExchange) {
    const prior = this.state.exchanges.find(item => item.requestId === exchange.requestId)
    if (prior && prior.threadId !== exchange.threadId) throw new Error('请求回执与原会话不匹配，已拒绝更新。')
    const next = { ...prior, ...exchange, startedAt: prior?.startedAt ?? exchange.startedAt ?? Date.now() }
    this.update({ exchanges: prior ? this.state.exchanges.map(item => item.requestId === exchange.requestId ? next : item) : [...this.state.exchanges, next],
      threads: this.state.threads.map(thread => thread.threadId === exchange.threadId ? { ...thread, updatedAt: Math.floor(Date.now() / 1000) } : thread) })
  }

  private requestsPass?: Promise<void>
  refreshRequests(): Promise<void> { return this.requestsPass ??= this.pollRequests().finally(() => { this.requestsPass = undefined }) }
  private async pollRequests() {
    if (hidden()) return
    const request = this.requestsAbort = new AbortController()
    // Direct sends keep their receipt heartbeat after turn binding; native creations have no relay request.
    for (const pending of this.state.exchanges.filter(item => item.status === 'pending' && item.submitted === true)) {
      if (request.signal.aborted) return
      try {
        const response = await fetch('/session-hub/api/codex/requests/' + encodeURIComponent(pending.requestId), { headers: { 'x-orchestrator-request': '1' }, signal: request.signal })
        if (!response.ok) continue
        const value = await response.json()
        if (request.signal.aborted || this.state.exchanges.find(item => item.requestId === pending.requestId)?.status !== 'pending') continue
        const delivery: CodexDelivery | undefined = ['desktop_queue', 'desktop_app', 'native_image_queue', 'native_user_queue'].includes(value.delivery?.transport) ? {
          transport: value.delivery.transport,
          ...(typeof value.delivery.queueId === 'string' ? { queueId: value.delivery.queueId } : {}),
          ...(typeof value.delivery.receiptId === 'string' ? { receiptId: value.delivery.receiptId } : {}),
          ...(typeof value.delivery.clientUserMessageId === 'string' ? { clientUserMessageId: value.delivery.clientUserMessageId } : {}),
        } : undefined
        if (value.status === 'completed') {
          if (value.reply?.threadId !== pending.threadId || typeof value.reply.turnId !== 'string' || typeof value.reply.text !== 'string') {
            this.addExchange({ ...pending, status: 'uncertain', error: '回复与原会话不匹配，请核对原会话；不会重新发送。' })
          } else {
            this.addExchange({ ...pending, status: 'completed', turnId: value.reply.turnId, text: value.reply.text, ...(delivery ? { delivery } : {}) })
            void this.refreshActivities()
          }
        } else if (value.status === 'uncertain' || value.status === 'unknown') {
          this.addExchange({ ...pending, status: 'uncertain', error: value.error || '结果未知，请检查原会话，避免重复发送。', ...(delivery ? { delivery } : {}) })
        } else if (value.status === 'pending' && delivery) {
          this.addExchange({ ...pending, delivery })
        }
      } catch { /* A transient heartbeat failure does not imply that a send failed. */ }
    }
  }
  private cancelTranscript(threadId: string) {
    if (this.historyRequest?.threadId !== threadId) return
    this.historyRequest.controller.abort()
    this.historyRequest = undefined
    const previous = this.state.transcripts[threadId]
    if (previous?.loading) this.update({ transcripts: { ...this.state.transcripts, [threadId]: { ...previous, loading: false } } })
  }
  loadTranscript(threadId: string, more = false, force = false): Promise<void> {
    const previous = this.state.transcripts[threadId]
    if (!more && !force && previous?.loaded || more && !previous?.nextCursor) return Promise.resolve()
    const active = this.historyRequest
    if (active && !active.controller.signal.aborted) {
      if (active.threadId === threadId) {
        if (more && !active.more) return active.promise.then(() => active.controller.signal.aborted ? undefined : this.loadTranscript(threadId, true))
        return active.promise
      }
      this.cancelTranscript(active.threadId)
    }
    const controller = new AbortController()
    const request = { threadId, more, controller, promise: Promise.resolve() }
    this.historyRequest = request
    request.promise = this.readTranscript(threadId, more, controller).finally(() => {
      if (this.historyRequest === request) this.historyRequest = undefined
    })
    return request.promise
  }
  private async readTranscript(threadId: string, more: boolean, request: AbortController) {
    const base = this.state.transcripts[threadId] ?? { threadId, turns: [], nextCursor: null, loaded: false, loading: false, error: '' }
    const put = (value: TranscriptState) => this.update({ transcripts: { ...this.state.transcripts, [threadId]: value } })
    put({ ...base, loading: true, error: '', syncPaused: false })
    let timedOut = false
    const timeout = setTimeout(() => {
      if (request.signal.aborted) return
      timedOut = true; request.abort()
      put({ ...base, loading: false, error: '会话内容更新超时，保留上次消息；稍后自动重连。', syncPaused: false })
    }, 20000)
    try {
      // Refresh only the latest five turns; keep already loaded earlier pages in memory.
      const response = await fetch('/session-hub/api/codex/transcript?' + new URLSearchParams({ threadId, limit: '5', ...(more ? { cursor: base.nextCursor! } : {}) }),
        { headers: { 'x-orchestrator-request': '1' }, signal: request.signal })
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('会话内容接口尚未加载。')
      const result = await response.json() as CodexTranscript & { error?: string }
      if (!response.ok) throw new Error(result.error ?? '无法读取此会话内容。')
      if (result.threadId !== threadId || !Array.isArray(result.turns)) throw new Error('会话内容回执不匹配。')
      if (request.signal.aborted) return
      const knownIds = new Set(base.turns.map(turn => turn.id))
      const gap = base.loaded && base.turns.length > 0 && result.turns.length > 0 && !result.turns.some(turn => knownIds.has(turn.id))
      const turns = [...new Map([...base.turns, ...result.turns].map(turn => [turn.id, turn])).values()]
        .sort((a, b) => a.startedAt - b.startedAt)
      put({ ...result, turns, nextCursor: more || !base.loaded || gap ? result.nextCursor : base.nextCursor,
        loading: false, loaded: true, error: '', lastSyncedAt: Date.now(), syncPaused: false })
      this.reconcileTranscript(threadId)
    } catch (error) { if (!request.signal.aborted && !timedOut) put({ ...base, loading: false, error: error instanceof Error ? error.message : '无法读取会话内容。', syncPaused: false }) }
    finally { clearTimeout(timeout) }
  }
  private reconcileTranscript(threadId: string) {
    const history = this.state.transcripts[threadId]
    if (!history || history.error) return
    for (const pending of this.state.exchanges.filter(item => item.threadId === threadId && ['pending', 'uncertain'].includes(item.status ?? ''))) {
      const clientId = pending.delivery?.clientUserMessageId
      const turn = pending.turnId ? history.turns.find(turn => turn.id === pending.turnId)
        : clientId ? history.turns.find(turn => turn.messages.some(message => message.role === 'user' && message.clientId === clientId)) : undefined
      if (turn?.status === 'completed') this.addExchange({ ...pending, turnId: turn.id, status: 'completed', error: undefined,
        text: turn.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n') })
      else if (turn && ['failed', 'interrupted'].includes(turn.status)) this.addExchange({ ...pending, turnId: turn.id, status: 'uncertain', error: '原会话本轮已停止，请核对结果；不会重新发送。' })
      else if (turn && !pending.turnId) this.addExchange({ ...pending, turnId: turn.id, status: 'pending', error: undefined })
    }
  }
  /** Only the visible conversation polls text. Activity heartbeats never fetch message history. */
  watchTranscript(threadId: string): () => void {
    this.transcriptWatcher?.stop()
    let live = true, running = false, requested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pause = () => {
      clearTimeout(timer); this.cancelTranscript(threadId)
      const previous = this.state.transcripts[threadId]
      if (previous) this.update({ transcripts: { ...this.state.transcripts, [threadId]: { ...previous, loading: false, syncPaused: true } } })
    }
    const poll = async () => {
      if (!live || hidden()) return
      if (running) { requested = true; return }
      clearTimeout(timer); running = true
      try { await this.loadTranscript(threadId, false, true) }
      finally {
        running = false
        if (!live || hidden()) return
        if (requested) { requested = false; void poll(); return }
        const active = this.state.activities[threadId]?.state === 'running'
          || this.state.exchanges.some(item => item.threadId === threadId && item.status === 'pending')
        timer = setTimeout(() => { void poll() }, active ? 5000 : 15000)
      }
    }
    const visibility = () => { if (hidden()) pause(); else { requested = false; void poll() } }
    const stop = () => {
      if (!live) return
      live = false; pause()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
      if (this.transcriptWatcher?.stop === stop) this.transcriptWatcher = undefined
    }
    this.transcriptWatcher = { threadId, stop }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
    if (hidden()) pause(); else void poll()
    return stop
  }
  async refresh(query = this.state.query, more = false) {
    this.request?.abort()
    const controller = new AbortController(); this.request = controller
    this.update({ loading: true, error: '', query })
    try {
      const headers = { 'x-orchestrator-request': '1' }
      const offset = more ? this.state.nextOffset ?? 0 : 0
      const response = await fetch('/session-hub/api/context/threads?' + new URLSearchParams({ query, offset: String(offset), limit: '50' }), { headers, signal: controller.signal })
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Codex 工作区接口尚未就绪，请确认已构建并加载新版插件。')
      const result = await response.json() as { threads: CodexThread[]; total: number; nextOffset: number | null }
      if (!Array.isArray(result.threads)) throw new Error('Codex 会话目录返回格式错误。')
      const capability = await fetch('/session-hub/api/codex/capabilities', { headers, signal: controller.signal })
      const allowedThreadIds = capability.ok ? ((await capability.json()) as { allowedThreadIds: string[] }).allowedThreadIds : []
      if (!controller.signal.aborted) {
        this.update({ threads: more ? [...new Map([...this.state.threads, ...result.threads].map(item => [item.threadId, item])).values()] : result.threads,
          total: result.total, nextOffset: result.nextOffset, allowedThreadIds, loading: false })
        void this.refreshActivities()
      }
    } catch (error) { if (!controller.signal.aborted) this.update({ loading: false, error: error instanceof Error ? error.message : '无法读取 Codex 元数据。' }) }
  }
  start() {
    if (this.viewers++ === 0) {
      this.visibilityListener = () => {
        if (hidden()) { this.request?.abort(); this.activityRequest?.abort(); this.requestsAbort?.abort(); return }
        void this.refresh(); void this.refreshRequests(); void this.refreshActivities()
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityListener)
      this.requestTimer = setInterval(() => { void this.refreshRequests() }, 2000)
      if (!hidden()) void this.refresh()
      this.timer = setInterval(() => { if (!hidden()) void this.refresh() }, 30000)
      this.activityTimer = setInterval(() => { void this.refreshActivities() }, 3000)
    }
    return () => {
      if (--this.viewers !== 0) return
      clearInterval(this.timer); clearInterval(this.activityTimer); clearInterval(this.requestTimer)
      this.request?.abort(); this.activityRequest?.abort(); this.requestsAbort?.abort(); this.transcriptWatcher?.stop()
      if (typeof document !== 'undefined' && this.visibilityListener) document.removeEventListener('visibilitychange', this.visibilityListener)
      this.visibilityListener = undefined
    }
  }
}
