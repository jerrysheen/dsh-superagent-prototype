import type { Assignment, Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { codexBinding } from './codex-state.ts'
import type { CodexExecutor } from './codex.ts'
import type { DesktopWorker } from './desktop-worker.ts'
import type { NativeWorkerDriver, NativeWorkerEvents } from './native-worker.ts'

/** Selects one execution port; never migrates an existing work's writer. */
export class NativeRouter implements NativeWorkerDriver {
  constructor(private store: Pick<Store, 'get' | 'tickets' | 'triggers'>, private background: CodexExecutor, private desktop: DesktopWorker) {}
  private port(ticket: Ticket) { return this.binding(ticket.id)?.transport === 'desktop' || this.desktop.handles(ticket) ? this.desktop : this.background }
  binding(id: string) { return this.store.get(codexBinding(id)) }
  handles(ticket: Ticket) { return this.background.handles(ticket) || this.desktop.handles(ticket) }
  running(id: string) { return this.desktop.running(id) || this.background.running(id) }
  holds(id: string, requestId: string) { return this.desktop.holds(id, requestId) || this.background.holds(id, requestId) }
  send(ticket: Ticket, assignment: Assignment, requestId: string, text: string, authorize: () => void, accepted?: () => void, inputIds?: string[]) {
    return this.port(ticket).send(ticket, assignment, requestId, text, authorize, accepted, inputIds)
  }
  stop(id: string, reason: string) { const ticket = this.store.tickets.get(id); return ticket ? this.port(ticket).stop(id, reason) : Promise.resolve() }
  install(events: NativeWorkerEvents) { const stop = [this.background.install(events), this.desktop.install(events)]; return () => { stop.forEach(dispose => dispose()) } }
  async shutdown() { await Promise.allSettled([this.desktop.shutdown(), this.background.shutdown()]) }
}
