/** Workspace/permission adapter for the original DSH Executor, with no lifecycle of its own. */
import { realpath, stat } from 'node:fs/promises'
import type { Ticket, Trigger } from '../core/index.ts'
import { LocalWorkConfig, workspaceKey } from '../app/local-work.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export function localPermission(trigger?: Trigger): 'read-only' | 'workspace-write' {
  if (trigger?.source !== 'local-work') throw new Error('Local execution requires a local-work origin')
  if (trigger.meta.permission === 'read-only') return 'read-only'
  if (trigger.meta.permission === 'workspace-write' && trigger.meta.writeAuthorization === 'EXPLICIT_WORKSPACE_WRITE') return 'workspace-write'
  throw new Error('Missing local execution permission')
}
export function localExecution(ticket: Ticket, trigger?: Trigger): Ticket {
  localPermission(trigger)
  const directory = workspaceKey(String(trigger!.meta.workspaceRoot))
  return { ...ticket, execution: { name: String(trigger!.meta.workId), directory, assignment: ticket.execution?.assignment ?? '' } }
}
/** Semantic routing cannot widen a source's explicit workspace or execution permission. */
export function validateLocalInput(origin: Trigger | undefined, incoming: Trigger | undefined): void {
  const permission = localPermission(origin)
  if (!incoming || incoming.source !== 'local-work'
    || workspaceKey(String(incoming.meta.workspaceRoot)) !== workspaceKey(String(origin!.meta.workspaceRoot))) {
    throw new Error('Cannot attach a different workspace to this local worker')
  }
  if (localPermission(incoming) !== permission) throw new Error('Cannot attach a different execution permission to this local worker')
  if ((origin!.meta.executor ?? 'dsh') !== (incoming.meta.executor ?? 'dsh') || origin!.meta.codexThreadId !== incoming.meta.codexThreadId
    || (origin!.meta.transport ?? 'app-server') !== (incoming.meta.transport ?? 'app-server')) {
    throw new Error('Cannot attach a different worker driver or native session to this work')
  }
}
export async function validateLocalWorkspace(ticket: Ticket, trigger: Trigger | undefined, sources: SourceRegistry): Promise<void> {
  localPermission(trigger)
  if (!sources.scope(trigger!).listened) throw new Error('Local workspace authorization was withdrawn')
  const directory = ticket.execution?.directory
  if (!directory || workspaceKey(directory) !== workspaceKey(String(trigger!.meta.workspaceRoot))) throw new Error('Ticket workspace does not match origin')
  if (!(await stat(directory)).isDirectory()) throw new Error('Local workspace must already exist')
  const actual = workspaceKey(await realpath(directory))
  const config = LocalWorkConfig.parse(sources.instance('local-work')?.config)
  // Require the configured root itself to be canonical; aliases cannot redirect execution to another root.
  if (!config.workspaces.some(item => workspaceKey(item.path) === workspaceKey(directory))) throw new Error('Workspace is not allowlisted')
  if (actual !== workspaceKey(directory)) throw new Error('Local workspace junctions/aliases require an explicit canonical root')
}
