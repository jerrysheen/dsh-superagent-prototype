/** Windows-native Codex execution connection, isolated from the existing read-only desktop reader. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexCommand } from '../app/codex-local-client.ts'
import { stopNative } from '../infra/native-command.ts'
export interface CodexEvent { method: string; params: any }
export interface CodexConnection {
  initialize(): Promise<void>
  request(method: string, params: unknown): Promise<any>
  subscribe(listener: (event: CodexEvent) => void): () => void
  close(): Promise<void>
}
/** Owns one App Server transport; no implicit re-sends, approval bypass or private-history exports. */
export class CodexRpc implements CodexConnection {
  private child
  private sequence = 0
  private closed = false
  private failed = false
  private closing?: Promise<void>
  private readonly listeners = new Set<(event: CodexEvent) => void>()
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  constructor() {
    const command = codexCommand(['app-server'])
    // An Engine port must identify itself through initialize, including when launched from a desktop task.
    const env = { ...process.env }; delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
    this.child = spawn(command.file, command.args, { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.resume()
    const fail = () => {
      if (this.closed || this.failed) return
      this.failed = true
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('CODEX_CONNECTION_LOST')) }
      this.pending.clear(); for (const listener of this.listeners) listener({ method: 'connection/lost', params: {} })
    }
    this.child.on('error', fail); this.child.on('close', fail); this.child.stdin.on('error', fail)
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: any; try { message = JSON.parse(line) } catch { return }
      if (message.method && message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32000, message: 'Engine worker cannot approve interactive or external tool requests' } }); return
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id); if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(Error(/writer|owned|already.*running|busy|in use/i.test(String(message.error.message)) ? 'CODEX_SESSION_BUSY' : 'CODEX_RPC_REJECTED_' + message.error.code))
        else pending.resolve(message.result)
      } else if (typeof message.method === 'string') for (const listener of this.listeners) listener(message)
    })
  }
  private send(value: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n') }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed || this.failed) return Promise.reject(Error('CODEX_CONNECTION_CLOSED'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => { this.pending.delete(id); reject(Error('CODEX_RPC_RECEIPT_UNCERTAIN')) }, 60000)
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params })
    })
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'superagent_engine_executor', title: 'SuperAgent Engine', version: '0.3.0' }, capabilities: { experimentalApi: true } })
    this.send({ method: 'initialized', params: {} })
  }
  subscribe(listener: (event: CodexEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  close() { return this.closing ??= this.closeOwned() }
  private async closeOwned() {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('CODEX_CONNECTION_CLOSED')) }
    this.pending.clear(); this.listeners.clear(); this.child.stdin.end()
    if (this.child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { void stopNative(this.child).finally(resolve) }, 3000)
      this.child.once('close', () => { clearTimeout(timer); resolve() })
    })
  }
}
