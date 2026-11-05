/** Native transport bindings and receipts; these project execution identity, not a second task lifecycle. */
import { family } from '../kv.ts'
export interface CodexReceipt {
  assignmentId: string; state: 'pending' | 'accepted' | 'completed' | 'interrupted' | 'failed' | 'uncertain'
  turnId?: string; inputIds: string[]; at: string
  baselineTurnId?: string; baselineMessageId?: string; baselineStatus?: string
  report?: { state: 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; question?: string }
  deliveryAccepted?: boolean
}
export interface CodexBinding {
  ticketId: string; threadId: string; workspace: string; permission: 'read-only' | 'workspace-write'
  createdByEngine: boolean; model?: string; requests: Record<string, CodexReceipt>
  named?: boolean
  transport?: 'desktop'
  effectivePermission?: 'desktop-settings'
  tracking?: 'active' | 'waiting-user' | 'finished' | 'detached' | 'uncertain'
  desktop?: { projectId: string; projectName: string; verifiedAt: string }
  desktopError?: string
  writer?: { state: 'held' | 'releasing' | 'released'; observedAt: string }
}
export const codexBinding = family<CodexBinding, [ticketId: string]>('codex-worker:')
