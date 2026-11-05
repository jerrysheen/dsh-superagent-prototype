/** Execution-only port; original DshExecutor continues to own slots, effects, retries and Engine callbacks. */
import type { Assignment, Ticket } from '../core/index.ts'
export interface NativeReport { state: 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; question?: string }
export interface NativeWorkerEvents {
  completed(ticketId: string, assignmentId: string, report: NativeReport, inputIds: string[]): void
  failed(ticketId: string, assignmentId: string, error: unknown): void
}
export interface NativeWorkerDriver {
  handles(ticket: Ticket): boolean
  running(ticketId: string): boolean
  holds(ticketId: string, requestId: string): boolean
  send(ticket: Ticket, assignment: Assignment, requestId: string, text: string,
    authorize: () => void, accepted?: () => void, inputIds?: string[]): Promise<void>
  stop(ticketId: string, reason: string): Promise<void>
  shutdown(): Promise<void>
  install(events: NativeWorkerEvents): () => void
}
