/** Windows Codex desktop metadata observer. Only lists threads; never resumes, sends or reads messages. */
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import type { SessionActivities } from './session-activity.ts'
import type { ContextTargets } from './context-targets.ts'
import type { ChatgptMetadataClient, ChatgptRow } from './chatgpt-source.ts'
import { workspaceKey } from './local-work.ts'
import { CodexReadClient } from './codex-local-client.ts'

interface DesktopRow { id: string; cwd: string; status: string; title?: string; updatedAt?: number }
interface Page { threads: DesktopRow[]; nextCursor?: string }
/** Reconnect after a desktop restart only when its native endpoint is unambiguous. */
export function desktopActivityPipe(configured: string, names: string[]) {
  const prefix = '\\\\.\\pipe\\', name = configured.slice(prefix.length)
  if (names.includes(name) || !/^codex-app-tools-[0-9a-f-]{36}$/i.test(name)) return configured
  const candidates = names.filter(value => /^codex-app-tools-[0-9a-f-]{36}$/i.test(value))
  return candidates.length === 1 ? prefix + candidates[0] : configured
}
/** Connects to the existing desktop app tools pipe using the bundled app-tools framing protocol. */
export class DesktopAppPipe {
  private socket?: Socket
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private tools = new Map<string, { name: string; namespace: string }>()
  constructor(private readonly pipePath: string, private readonly callerThreadId: string) {
    if (!pipePath.startsWith('\\\\.\\pipe\\') || !/^[0-9a-f-]{36}$/i.test(callerThreadId)) throw Error('Invalid desktop observer connection')
  }
  private async connect() {
    if (this.socket && !this.socket.destroyed) return
    const pipePath = desktopActivityPipe(this.pipePath, await readdir('\\\\.\\pipe\\'))
    const socket = createConnection(pipePath); this.socket = socket; this.buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      if (socket !== this.socket) return
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0)
        if (size > 8 * 1024 * 1024) { this.close(); return }
        if (this.buffer.length < size + 4) return
        const body = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4)
        try {
          const response = JSON.parse(body.toString()), pending = this.pending.get(Number(response.id))
          if (!pending) continue
          this.pending.delete(Number(response.id)); clearTimeout(pending.timer)
          response.error ? pending.reject(Error('Desktop status request rejected')) : pending.resolve(response.result)
        } catch { this.close(); return }
      }
    })
    socket.on('error', () => this.disconnect(socket)); socket.on('close', () => this.disconnect(socket))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(Error('Desktop status connection timeout')) }, 3000)
      socket.once('connect', () => { clearTimeout(timer); resolve() })
      socket.once('error', () => { clearTimeout(timer); reject(Error('Desktop status connection unavailable')) })
    })
  }
  private disconnect(socket: Socket) {
    if (socket !== this.socket) return
    this.socket = undefined; this.tools.clear(); this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Desktop status disconnected')) }
    this.pending.clear()
  }
  private async request(method: 'tools/list' | 'tools/call', params: unknown, timeoutMs = 5000): Promise<any> {
    await this.connect()
    const id = ++this.sequence, socket = this.socket!
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.close(); reject(Error('Desktop request timeout; outcome may be unknown')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const payload = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params })), frame = Buffer.alloc(payload.length + 4)
      frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame)
    })
  }
  protected async callTool(name: 'list_threads' | 'send_message_to_thread' | 'list_projects' | 'move_thread_to_project' | 'create_thread' | 'wait_threads', args: unknown, callId?: string) {
    if (!this.tools.has(name)) {
      const result = await this.request('tools/list', { threadStartKind: 'all' })
      const found = result.tools?.find((tool: any) => typeof tool.name === 'string' && tool.name.split('__').at(-1) === name)
      if (!found || typeof found.namespace !== 'string') throw Error('Desktop thread listing unavailable')
      this.tools.set(name, { name: found.name, namespace: found.namespace })
    }
    const tool = this.tools.get(name)!
    const result = await this.request('tools/call', {
      arguments: args, callerSource: 'codex', namespace: tool.namespace, tool: tool.name, threadId: this.callerThreadId,
      callId: callId ?? 'dsh-status-' + randomUUID(), turnId: name === 'send_message_to_thread' || name === 'create_thread' ? 'dsh-user-confirmed-work' : 'dsh-project-metadata',
    }, ['send_message_to_thread', 'create_thread', 'wait_threads'].includes(name) ? 30000 : 5000)
    if (!result.success) throw Error(name === 'move_thread_to_project' ? '桌面拒绝项目登记：该后台会话尚不是可管理的侧栏任务。' : 'Desktop status listing rejected')
    return result
  }
  close() { const socket = this.socket; if (socket) { socket.destroy(); this.disconnect(socket) } }
}

export interface DesktopWorkSnapshot {
  cursor?: string
  thread: { id: string; hostId?: string; status: { type: string } }
  latestTurn?: { id: string; status: string; completedAt?: number | null }
  latestAssistantMessage?: { id: string; turnId: string; text: string; phase?: string }
}
interface DesktopResultReader { initialize(): Promise<void>; request(method: string, params: unknown): Promise<any>; close(): void }
/** The desktop owns these sessions. No app-server resume, turn/start, history reads, or writer acquisition. */
export class DesktopWorkClient extends DesktopAppPipe {
  private reader?: DesktopResultReader
  constructor(pipe: string, caller: string, private readerFactory: () => DesktopResultReader = () => new CodexReadClient()) { super(pipe, caller) }
  private json(result: any) {
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text
    if (typeof text !== 'string') throw Error('桌面工作接口没有返回有效回执。')
    return JSON.parse(text)
  }
  async project(workspace: string) {
    const value = this.json(await this.callTool('list_projects', {}))
    const matches = value.projects?.filter((project: any) => project.projectKind === 'local' && project.hostId === 'local'
      && typeof project.path === 'string' && workspaceKey(project.path) === workspaceKey(workspace))
    if (!Array.isArray(matches) || matches.length !== 1 || typeof matches[0].projectId !== 'string') throw Error('请先在桌面添加唯一对应的 workspace；尚未派发。')
    return { projectId: matches[0].projectId as string, projectName: String(matches[0].label ?? '') }
  }
  async create(projectId: string, title: string, prompt: string, requestId: string) {
    const value = this.json(await this.callTool('create_thread', { target: { type: 'project', projectId, environment: { type: 'local' } }, title, prompt, model: 'gpt-6.1-sol', thinking: 'medium' }, requestId))
    if (typeof value.threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.threadId) || value.hostId && value.hostId !== 'local') {
      throw Error('桌面创建结果尚未确定；不会自动重复创建，请在桌面核对。')
    }
    return { threadId: value.threadId as string, hostId: 'local' }
  }
  async verifyProject(threadId: string, workspace: string, projectId: string) {
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const value = this.json(await this.callTool('list_threads', { mode: 'history', source: 'codex', hostId: 'local', limit: 50, ...(cursor ? { cursor } : {}) }))
      const row = value.threads?.find((row: any) => row.id === threadId)
      if (row) {
        if (row.hostId !== 'local' || row.projectId !== projectId || typeof row.cwd !== 'string' || workspaceKey(row.cwd) !== workspaceKey(workspace)) throw Error('桌面会话不属于已授权的 workspace；未发送。')
        return { threadId, projectId, title: String(row.title ?? '') }
      }
      if (typeof value.nextCursor !== 'string' || value.nextCursor === cursor) break
      cursor = value.nextCursor
    }
    throw Error('桌面没有找到指定的原生会话；未发送。')
  }
  async send(threadId: string, prompt: string, requestId: string) {
    const value = this.json(await this.callTool('send_message_to_thread', { threadId, hostId: 'local', prompt }, requestId))
    if (value.threadId !== threadId) throw Error('桌面发送结果没有匹配的会话回执；不会重复发送。')
  }
  async snapshot(threadId: string, afterCursor?: string): Promise<DesktopWorkSnapshot> {
    // The service transport rejected wait_threads in live acceptance. Use desktop metadata
    // and a read-only connection limited to the current dispatched turn's result instead.
    void afterCursor
    const value = this.json(await this.callTool('list_threads', { mode: 'history', source: 'codex', hostId: 'local', limit: 50 }))
    const row = value.threads?.find((row: any) => row.id === threadId)
    if (!row || row.hostId !== 'local') throw Error('桌面暂未提供该工单的可靠状态；不会重复派发。')
    if (!this.reader) { this.reader = this.readerFactory(); await this.reader.initialize() }
    const turns = await this.reader.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    const turn = turns.data?.[0]
    if (turn?.items?.length) throw Error('结果连接返回了未经请求的会话内容。')
    const result: DesktopWorkSnapshot = { thread: { id: threadId, hostId: 'local', status: { type: row.status } },
      ...(turn ? { latestTurn: { id: turn.id, status: turn.status === 'interrupted' && !turn.completedAt && row.status === 'active' ? 'inProgress' : turn.status, completedAt: turn.completedAt } } : {}) }
    if (!turn || turn.status !== 'completed' || !turn.completedAt) return result
    // Read no earlier turns. Discard user messages; only the current final answer can be a candidate receipt.
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const items = await this.reader.request('thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(items.data)) throw Error('桌面本轮结果返回无效。')
      for (const entry of items.data) {
        if (entry.turnId !== turn.id) throw Error('拒绝读取其他轮次。')
        const item = entry.item
        if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.length <= 64000
          && (item.phase === 'final_answer' || !item.phase && !result.latestAssistantMessage)) {
          result.latestAssistantMessage = { id: item.id, turnId: turn.id, text: item.text, phase: item.phase }
        }
      }
      if (!items.nextCursor) return result
      if (items.nextCursor === cursor) throw Error('本轮结果分页重复。')
      cursor = items.nextCursor
    }
    throw Error('本轮结果超出读取上限；请在桌面查看。')
  }
  override close() { this.reader?.close(); this.reader = undefined; super.close() }
}

/** Publishes only an Engine-created thread to the matching local desktop project. Never creates a turn or acquires its writer. */
export class DesktopProjectClient extends DesktopAppPipe {
  private value(result: any) {
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text
    if (typeof text !== 'string') throw Error('桌面项目元数据返回无效。')
    return JSON.parse(text)
  }
  private async findThread(threadId: string) {
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const value = this.value(await this.callTool('list_threads', { mode: 'history', source: 'codex', hostId: 'local', limit: 50, ...(cursor ? { cursor } : {}) }))
      const row = value.threads?.find((row: any) => row.id === threadId)
      if (row) return { id: row.id, cwd: row.cwd, projectId: row.projectId, hostId: row.hostId }
      if (typeof value.nextCursor !== 'string' || value.nextCursor === cursor) break
      cursor = value.nextCursor
    }
    throw Error('桌面目录尚未发现此工单会话，不能宣称已显示在项目中。')
  }
  async publish(threadId: string, workspace: string) {
    const value = this.value(await this.callTool('list_projects', {}))
    const projects = value.projects?.filter((project: any) => project.projectKind === 'local' && project.hostId === 'local'
      && typeof project.path === 'string' && workspaceKey(project.path) === workspaceKey(workspace))
    if (!Array.isArray(projects) || projects.length !== 1 || typeof projects[0].projectId !== 'string') throw Error('桌面没有唯一匹配的本地工程，请先在桌面添加该工程。')
    const project = projects[0]
    // cwd alone is not project membership. This id comes from Engine's validated local thread/start binding.
    await this.callTool('move_thread_to_project', { threadId, hostId: 'local', projectId: project.projectId, source: 'codex' })
    const after = await this.findThread(threadId)
    if (after.projectId !== project.projectId || after.hostId !== 'local' || typeof after.cwd !== 'string' || workspaceKey(after.cwd) !== workspaceKey(workspace)) throw Error('桌面工程归属尚未得到元数据确认。')
    return { projectId: project.projectId as string, projectName: String(project.label ?? ''), verifiedAt: new Date().toISOString() }
  }
}
/** Observer exposes no send operation; it only lists native metadata. */
export class DesktopActivityClient extends DesktopAppPipe {
  async read(cursor?: string): Promise<Page> {
    const result = await this.callTool('list_threads', { mode: 'history', limit: 50, ...(cursor ? { cursor } : {}) })
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text
    const value = JSON.parse(text)
    if (!Array.isArray(value.threads)) throw Error('Invalid desktop status list')
    // Titles are catalog metadata; discard summaries and any message excerpts.
    return { threads: value.threads.filter((row: any) => typeof row.id === 'string' && typeof row.cwd === 'string' && typeof row.status === 'string')
      .map((row: any) => ({ id: row.id, cwd: row.cwd, status: row.status,
        ...(typeof row.title === 'string' ? { title: row.title.slice(0, 350) } : {}), ...(Number.isSafeInteger(row.updatedAt) ? { updatedAt: row.updatedAt } : {}) })), ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) }
  }
}
/** Lists ChatGPT cloud metadata through its explicit source; discards summaries and all content fields. */
export class DesktopChatgptClient extends DesktopAppPipe implements ChatgptMetadataClient {
  async read(cursor?: string) {
    const result = await this.callTool('list_threads', { mode: 'history', source: 'chatgpt', archived: false, limit: 50, ...(cursor ? { cursor } : {}) })
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text
    const value = JSON.parse(text)
    if (!Array.isArray(value.threads)) throw new Error('Invalid ChatGPT metadata list')
    const threads: ChatgptRow[] = value.threads.map((row: any) => {
      if (row.kind !== 'chatgpt' || typeof row.id !== 'string' || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt))
        throw new Error('Invalid ChatGPT metadata row')
      return { id: row.id, title: typeof row.title === 'string' ? row.title.slice(0, 500) : '', updatedAt: row.updatedAt,
        projectId: typeof row.projectId === 'string' ? row.projectId.slice(0, 200) : null,
        status: typeof row.status === 'string' ? row.status.slice(0, 50) : 'unknown' }
    })
    return { threads, ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) }
  }
}
/** Used only by an explicit selected-session send, never by the observer. Desktop opens unloaded threads. */
export class DesktopChatClient extends DesktopAppPipe {
  async send(threadId: string, prompt: string, requestId: string, requireTargetReceipt = false) {
    const result = await this.callTool('send_message_to_thread', { threadId, prompt }, requestId)
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text
    let value: { threadId?: string } | undefined
    try { value = JSON.parse(text) } catch { /* Missing JSON is not proof of a successful cloud submission. */ }
    if (value?.threadId && value.threadId !== threadId) throw Error('Desktop target mismatch')
    if (requireTargetReceipt && value?.threadId !== threadId) throw Error('云端提交未返回匹配的目标回执，发送结果待核对')
    return { receiptId: requestId, transport: 'desktop_app' as const }
  }
}

/** Polls desktop-owned activity independently of Engine execution and reconnects after transport errors. */
export class DesktopActivityObserver {
  private timer?: ReturnType<typeof setInterval>
  private pass?: Promise<void>
  private stopped = false
  constructor(private readonly host: { client: Pick<DesktopActivityClient, 'read' | 'close'>; activities: SessionActivities;
    targets: ContextTargets; intervalMs?: number; changed?(): void; sync?(rows: DesktopRow[]): void }) {}
  tick() { return this.pass ??= this.poll().finally(() => { this.pass = undefined }) }
  private async poll() {
    const needed = new Set(this.host.activities.watched())
    let cursor: string | undefined; const cursors = new Set<string>()
    try {
      for (let page = 0; page < 10 && !this.stopped; page++) {
        const observedAt = new Date().toISOString(), result = await this.host.client.read(cursor)
        if (this.stopped) return
        this.host.sync?.(result.threads)
        const cards = new Map(this.host.targets.cards().map(card => [card.threadId, card]))
        const sessions = result.threads.flatMap(row => {
          const card = cards.get(row.id)
          if (!card || card.archived) return []
          try { if (workspaceKey(row.cwd) !== card.workspace) return [] } catch { return [] }
          needed.delete(row.id)
          // Only an explicit idle observation can release deferred work. notLoaded is not completion evidence.
          const state = row.status === 'active' ? 'running' as const : row.status === 'idle' ? 'idle' as const : 'unknown' as const
          return [{ threadId: row.id, workspace: row.cwd, state,
            ...(state === 'unknown' ? { reason: 'Desktop status ' + row.status.slice(0, 80) + ' does not prove idle or completion' } : {}) }]
        })
        if (sessions.length) { this.host.activities.publish({ observedAt, sessions }); this.host.changed?.() }
        if (!needed.size || !result.nextCursor || cursors.has(result.nextCursor)) return
        cursor = result.nextCursor; cursors.add(cursor)
      }
    } catch {
      this.host.activities.invalidateDesktop()
      this.host.client.close() // The next poll reconnects; failure is never evidence that work completed.
      this.host.changed?.()
    }
  }
  start() { void this.tick(); this.timer = setInterval(() => { void this.tick() }, this.host.intervalMs ?? 3000); this.timer.unref?.() }
  async stop() { this.stopped = true; clearInterval(this.timer); this.host.client.close(); await this.pass }
}
