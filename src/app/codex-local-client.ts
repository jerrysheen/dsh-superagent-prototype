/** Official CLI transport. Read-only RPC connection never resumes or acquires a native thread writer. */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function codexCommand(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const override = environment.CODEX_CLI_PATH || environment.CODEX_APP_SERVER_EXE
  if (override && (!isAbsolute(override) || !existsSync(override) || !/\.(exe|cmd)$/i.test(override))) throw new Error('显式指定的 Codex CLI 不可用；未回退到其他版本，未发送。')
  const desktopRoot = environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  const desktop = desktopRoot && existsSync(desktopRoot) ? readdirSync(desktopRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => join(desktopRoot, entry.name, 'codex.exe')).filter(path => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || left.localeCompare(right)) : []
  const dirs = [environment.APPDATA && join(environment.APPDATA, 'npm'), environment.USERPROFILE && join(environment.USERPROFILE, '.codex', 'bin'), ...String(environment.PATH ?? '').split(delimiter)]
    .filter((p): p is string => !!p && isAbsolute(p))
  const file = [override, ...desktop, ...dirs.flatMap(dir => ['codex.exe', 'codex.cmd'].map(name => join(dir, name)))]
    .find((p): p is string => !!p && isAbsolute(p) && existsSync(p) && /\.(exe|cmd)$/i.test(p))
  if (!file) throw new Error('未找到原生 Windows Codex CLI；未发送。')
  if (extname(file).toLowerCase() === '.exe') return { file, args }
  const entry = join(dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (!existsSync(entry)) throw new Error('Codex CLI 安装不完整；未发送。')
  return { file: process.execPath, args: [entry, ...args] }
}

export function queueCodexMessage(threadId: string, question: string): Promise<string> {
  const command = codexCommand(['queue', '--thread', threadId, '--message=' + question])
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) { reject(new Error('Codex 队列请求失败或超时，发送状态未知；不会自动重发。')); return }
      const result = /Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})/i.exec(String(stdout))
      if (!result || result[2]!.toLowerCase() !== threadId.toLowerCase()) { reject(new Error('未取得目标会话的队列回执，结果未知；不会自动重发。')); return }
      resolve(result[1]!)
    })
  })
}

/** Provides bounded native Codex read operations through its existing local protocol. */
export class CodexReadClient {
  private child
  private lines
  private sequence = 0
  private closed = false
  private readonly timeoutMs: number
  private failure?: Error
  private pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(timeoutMs = 15000) {
    this.timeoutMs = Math.max(15000, Math.min(120000, timeoutMs))
    const command = codexCommand(['app-server'])
    this.child = spawn(command.file, command.args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.resume()
    const fail = () => {
      if (this.closed) return
      this.failure = new Error('Codex 只读连接断开；不会自动重新发送问题。')
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.failure) }
      this.pending.clear()
    }
    this.child.on('error', fail); this.child.on('close', fail); this.child.stdin.on('error', fail)
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.method && message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32000, message: 'Read-only metadata connection does not approve requests' } }); return
      }
      const p = this.pending.get(message.id); if (!p) return
      this.pending.delete(message.id); clearTimeout(p.timer)
      if (message.error) p.reject(new Error('Codex ' + p.method + ' 被拒绝（' + String(message.error.code) + '）。'))
      else p.resolve(message.result)
    })
  }
  private send(value: unknown) { this.child.stdin.write(JSON.stringify(value) + '\n') }
  request(method: string, params: unknown): Promise<any> {
    // This connection must never take over a thread, approve a tool or submit a model turn.
    if (!['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list'].includes(method)) return Promise.reject(new Error('Unsupported read-only Codex method'))
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('Codex connection closed'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex ' + method + ' 读取超时。')) }, this.timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer }); this.send({ id, method, params })
    })
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'dsh_workspace_reader', title: 'DSH Workspace', version: '0.2.0' } })
    this.send({ method: 'initialized', params: {} })
  }
  close() {
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed')) }
    this.pending.clear(); this.lines.close(); this.child.kill()
  }
}
