/** Stable Cursor project/work identities for the original SuperAgent Trigger -> Ticket Engine. */
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import type { ThreadRef, Trigger } from '../core/model.ts'

const Name = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const SOURCE = 'cursor-local'
const named = (value: string, label: string): string => {
  if (!Name.test(value)) throw new Error('Invalid ' + label + ': use stable alphanumeric IDs')
  return value
}
export function canonicalCursorWorkspace(path: string): string {
  if (typeof path !== 'string' || !/^[a-zA-Z]:[\\/]/.test(path) || !win32.isAbsolute(path)) {
    throw new Error('Cursor project root must be a local absolute Windows path')
  }
  const value = win32.normalize(path).replace(/[\\]+$/, '')
  if (!win32.isAbsolute(value)) throw new Error('Invalid Cursor workspace')
  return value.toLowerCase()
}
export function cursorProjectKey(root: string): string {
  return createHash('sha256').update(canonicalCursorWorkspace(root)).digest('hex').slice(0, 20)
}
export function cursorSessionUid(root: string, surface: 'cli' | 'ide', nativeId: string): string {
  if (typeof nativeId !== 'string' || !/^[a-zA-Z0-9_-]{6,120}$/.test(nativeId)) throw new Error('Invalid native Cursor Session ID')
  return 'cursor:' + surface + ':' + cursorProjectKey(root) + ':' + nativeId
}
/** One work thread maps to a Ticket, not to every Session in a project. */
export function cursorWorkThread(root: string, workId: string): ThreadRef {
  return { source: SOURCE, id: cursorProjectKey(root) + '/' + named(workId, 'workId') }
}
export interface CursorLocalMessage {
  root: string
  workId: string
  eventId: string
  instruction: string
  at: string
}
export function cursorTrigger(message: CursorLocalMessage): Trigger {
  const thread = cursorWorkThread(message.root, message.workId)
  if (!message.instruction.trim()) throw new Error('Task cannot be empty')
  if (!Number.isFinite(Date.parse(message.at))) throw new Error('Invalid trigger time')
  return {
    id: SOURCE + ':' + named(message.eventId, 'eventId'),
    source: SOURCE, threads: [thread],
    actor: { source: SOURCE, id: 'local-operator' }, human: true, addressed: 'direct',
    at: message.at, text: message.instruction,
    meta: { projectKey: cursorProjectKey(message.root), workspaceRoot: canonicalCursorWorkspace(message.root),
      workId: message.workId, transport: 'cursor-cli' },
  }
}
