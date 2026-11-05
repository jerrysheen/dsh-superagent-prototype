/** One plugin-owned metadata view shared by its sidebar and main panel. */
export interface CodexThread { provider: 'codex'; threadId: string; title: string; cwd: string; projectName: string; updatedAt: number }
import type { CodexTranscript } from '../app/codex-transcript.ts'
import type { SessionActivity } from '../app/session-activity.ts'
export interface CodexExchange { requestId: string; threadId: string; question: string; text: string; submitted?: boolean; status?: 'pending' | 'completed' | 'uncertain'; error?: string; turnId?: string; startedAt?: number; images?: { src: string; alt: string }[] }
export interface TranscriptState extends CodexTranscript { loaded: boolean; loading: boolean; error: string }
export interface CodexWorkspaceState {
  threads: CodexThread[]; selected: CodexThread | null; total: number; nextOffset: number | null;
  loading: boolean; error: string; query: string; allowedThreadIds: string[]; exchanges: CodexExchange[]; transcripts: Record<string, TranscriptState>;
  newTarget?: { cwd: string; projectName: string };
  activities: Record<string, SessionActivity>
}
/** Holds browser-side native question state independently of Engine task records. */
export class CodexWorkspaceStore {
  private state: CodexWorkspaceState = { threads: [], selected: null, total: 0, nextOffset: null, loading: true, error: '', query: '', allowedThreadIds: [], exchanges: [], transcripts: {}, activities: {} }
  private listeners = new Set<() => void>()
  private request?: AbortController
  private historyRequest?: AbortController
  private viewers = 0
  private timer?: ReturnType<typeof setInterval>
  private requestTimer?: ReturnType<typeof setInterval>
  private activityTimer?: ReturnType<typeof setInterval>
  private activityRequest?: AbortController
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(next: Partial<CodexWorkspaceState>) { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener() }
  newConversation = (cwd: string, projectName: string) => this.update({ selected: null, newTarget: { cwd, projectName } })
  select = (selected: CodexThread) => { this.update({ selected, newTarget: undefined }); void this.refreshActivities() }
  async refreshActivities() {
    const threadIds = [...new Set([this.state.selected?.threadId, ...this.state.threads.map(t => t.threadId)].filter((id): id is string => !!id))].slice(0, 100)
    if (!threadIds.length) return
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
    const next = { ...prior, ...exchange, startedAt: prior?.startedAt ?? exchange.startedAt ?? Date.now() }
    this.update({ exchanges: prior ? this.state.exchanges.map(item => item.requestId === exchange.requestId ? next : item) : [...this.state.exchanges, next],
      threads: this.state.threads.map(thread => thread.threadId === exchange.threadId ? { ...thread, updatedAt: Math.floor(Date.now() / 1000) } : thread) })
  }

  private requestsPass?: Promise<void>
  refreshRequests(): Promise<void> { return this.requestsPass ??= this.pollRequests().finally(() => { this.requestsPass = undefined }) }
  private async pollRequests() {
    for (const pending of this.state.exchanges.filter(item => item.status === 'pending' && item.submitted !== false && !item.turnId)) {
      try {
        const response = await fetch('/session-hub/api/codex/requests/' + encodeURIComponent(pending.requestId), { headers: { 'x-orchestrator-request': '1' } })
        if (!response.ok) continue
        const value = await response.json()
        if (this.state.exchanges.find(item => item.requestId === pending.requestId)?.status !== 'pending') continue
        if (value.status === 'completed' && value.reply?.threadId === pending.threadId && typeof value.reply.turnId === 'string' && typeof value.reply.text === 'string') {
          this.addExchange({ ...pending, status: 'completed', turnId: value.reply.turnId, text: value.reply.text })
          void this.refreshActivities()
        } else if (value.status === 'uncertain' || value.status === 'unknown') {
          this.addExchange({ ...pending, status: 'uncertain', error: value.error || '结果未知，请检查原会话，避免重复发送。' })
        }
      } catch { /* A transient heartbeat failure does not imply that a send failed. */ }
    }
  }
  async loadTranscript(threadId: string, more = false, force = false) {
    const previous = this.state.transcripts[threadId]
    if (!more && !force && previous?.loaded) return
    if (more && !previous?.nextCursor) return
    this.historyRequest?.abort(); const request = new AbortController(); this.historyRequest = request
    const base = previous ?? { threadId, turns: [], nextCursor: null, loaded: false, loading: false, error: '' }
    const put = (value: TranscriptState) => this.update({ transcripts: { ...this.state.transcripts, [threadId]: value } })
    put({ ...base, loading: true, error: '' })
    try {
      const response = await fetch('/session-hub/api/codex/transcript?' + new URLSearchParams({ threadId, limit: '5', ...(more ? { cursor: previous!.nextCursor! } : {}) }),
        { headers: { 'x-orchestrator-request': '1' }, signal: request.signal })
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('会话内容接口尚未加载。')
      const result = await response.json() as CodexTranscript & { error?: string }
      if (!response.ok) throw new Error(result.error ?? '无法读取此会话内容。')
      if (result.threadId !== threadId || !Array.isArray(result.turns)) throw new Error('会话内容回执不匹配。')
      if (!request.signal.aborted) put({ ...result, turns: more ? [...new Map([...result.turns, ...base.turns].map(turn => [turn.id, turn])).values()] : result.turns,
        loading: false, loaded: true, error: '' })
    } catch (error) { if (!request.signal.aborted) put({ ...base, loading: false, error: error instanceof Error ? error.message : '无法读取会话内容。' }) }
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
    if (this.viewers++ === 0) { this.requestTimer = setInterval(() => { void this.refreshRequests() }, 2000); void this.refresh(); this.timer = setInterval(() => { void this.refresh() }, 30000); this.activityTimer = setInterval(() => { void this.refreshActivities() }, 3000) }
    return () => { if (--this.viewers === 0) { clearInterval(this.timer); clearInterval(this.activityTimer); clearInterval(this.requestTimer); this.request?.abort(); this.historyRequest?.abort(); this.activityRequest?.abort() } }
  }
}
