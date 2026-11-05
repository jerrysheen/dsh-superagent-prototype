/** Independent, metadata-only ChatGPT cloud source. No local-work binding, prompts or history reads. */
import { z } from 'zod'
import { record } from '../kv.ts'
import type { Store } from './store.ts'
import type { WorkerReference } from './worker-references.ts'

export const ChatgptSourceConfig = z.object({ enabled: z.boolean(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => Number.isFinite(Date.parse(value + 'T00:00:00+08:00')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value, 'Invalid date') }).strict()
export const ChatgptMetadata = z.object({ id: z.string().uuid(), title: z.string().max(500), updatedAt: z.number().finite().nonnegative(),
  projectId: z.string().max(200).nullable().default(null), status: z.string().max(50).default('unknown') }).strict()
export type ChatgptRow = z.infer<typeof ChatgptMetadata>
export interface ChatgptMetadataClient { read(cursor?: string): Promise<{ threads: ChatgptRow[]; nextCursor?: string }>; close(): void }
type SourceState = { config: z.infer<typeof ChatgptSourceConfig>; entries: ChatgptRow[]; lastSyncAt?: string }
const State = record<SourceState>('chatgpt-source:v1')
const defaults = { enabled: true, since: '2026-04-01' }

/** Syncs complete cloud inventories into an isolated namespace and applies the configured update-time boundary. */
export class ChatgptSource {
  private pass?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private revision = 0
  private error = ''
  private retryAt = 0
  private failures = 0
  private fullSyncAt = 0
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly client?: ChatgptMetadataClient) {}
  private state(): SourceState { return this.store.get(State) ?? { config: defaults, entries: [] } }
  private eligible(row: ChatgptRow, since: string) { return row.updatedAt * 1000 >= Date.parse(since + 'T00:00:00+08:00') }
  rows() {
    const state = this.state()
    return state.config.enabled ? state.entries.filter(row => this.eligible(row, state.config.since))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)) : []
  }
  view() {
    const state = this.state()
    return { ...state.config, timeBasis: 'updatedAt' as const, timezone: 'Asia/Shanghai', count: this.rows().length,
      syncing: !!this.pass, connected: !!this.client, lastSyncAt: state.lastSyncAt ?? null,
      error: this.error || (!this.client ? 'ChatGPT 桌面连接器尚未连接' : '') }
  }
  configure(input: unknown) {
    const config = ChatgptSourceConfig.parse(input), state = this.state()
    this.revision++
    this.store.set(State, { ...state, config, entries: state.entries.filter(row => this.eligible(row, config.since)) })
    if (this.pass) void this.pass.then(() => { if (!this.stopped) void this.sync() })
    else void this.sync()
    return this.view()
  }
  list(query = '', offset = 0, limit = 30) {
    const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
    const rows = this.rows().filter(row => words.every(word => [row.title, row.projectId ?? '', row.id].join(' ').normalize('NFKC').toLowerCase().includes(word)))
    return { threads: rows.slice(offset, offset + limit), total: rows.length, offset, ...this.state().config,
      nextOffset: offset + limit < rows.length ? offset + limit : null }
  }
  reference(uid: string): WorkerReference {
    const row = this.rows().find(row => 'chatgpt:' + row.id === uid)
    if (!row) throw new Error('引用的 ChatGPT 会话已不在启用的日期范围或目录中，请重新选择。')
    return { uid, threadId: row.id, provider: 'chatgpt', scope: 'cloud', title: row.title || '未命名 ChatGPT 会话',
      projectName: row.projectId ? 'ChatGPT 项目 ' + row.projectId : 'ChatGPT', workspace: '', summary: '' }
  }
  sync(): Promise<void> { return this.pass ??= this.poll().finally(() => { this.pass = undefined }) }
  check(): Promise<void> { return this.pass ??= this.poll(true).finally(() => { this.pass = undefined }) }
  private async poll(recent = false) {
    const { config } = this.state(), revision = this.revision
    if (this.stopped || !config.enabled || !this.client) return
    if (recent && Date.now() < this.retryAt) return
    const entries = new Map<string, ChatgptRow>(recent ? this.state().entries.map(row => [row.id, row]) : []), cursors = new Set<string>()
    let cursor: string | undefined
    try {
      for (let page = 0; page < 100; page++) {
        const result = await this.client.read(cursor)
        if (this.stopped || revision !== this.revision) return
        for (const raw of result.threads) {
          const row = ChatgptMetadata.parse(raw)
          if (this.eligible(row, config.since)) entries.set(row.id, row)
        }
        if (recent || !result.nextCursor) {
          this.store.set(State, { config, entries: [...entries.values()], lastSyncAt: new Date().toISOString() })
          if (!recent) this.fullSyncAt = Date.now()
          this.error = ''; this.failures = 0; this.retryAt = 0; return
        }
        if (cursors.has(result.nextCursor)) throw new Error('ChatGPT 目录分页游标重复，本次未替换目录')
        cursors.add(result.nextCursor); cursor = result.nextCursor
      }
      throw new Error('ChatGPT 目录超过分页上限，本次未替换目录')
    } catch (failure) {
      if (!this.stopped && revision === this.revision) this.error = failure instanceof Error ? failure.message : 'ChatGPT 同步失败'
      this.retryAt = Date.now() + Math.min(300000, 30000 * 2 ** this.failures++)
      this.client.close()
    }
  }
  start() { void this.sync(); this.timer = setInterval(() => { void (Date.now() - this.fullSyncAt > 900000 && Date.now() >= this.retryAt ? this.sync() : this.check()) }, 300000); this.timer.unref?.() }
  async stop() { this.stopped = true; clearInterval(this.timer); this.client?.close(); await this.pass }
}
