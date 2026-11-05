import { expect, it } from 'vitest'
import { localExecution, localPermission, validateLocalInput } from '../src/executor/local-dsh.ts'
import { localWorkTrigger } from '../src/app/local-work.ts'
import type { Ticket } from '../src/core/index.ts'
const input = { eventId: 'evt1', workId: 'work1', workspace: 'F:\\Github\\DSHSuperAgent', instruction: '只读分析' }
it('uses the explicit workspace without a repository prepare command or a new task lifecycle', () => {
  const ticket = { id: 'ticket1', execution: { name: 'old', directory: 'old', assignment: 'original brief' } } as Ticket
  const updated = localExecution(ticket, localWorkTrigger(input))
  expect(updated.execution).toEqual({ name: 'work1', directory: 'f:\\github\\dshsuperagent', assignment: 'original brief' })
  expect(updated.id).toBe(ticket.id)
  expect(localPermission(localWorkTrigger(input))).toBe('read-only')
  expect(localPermission(localWorkTrigger({ ...input, permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }))).toBe('workspace-write')
  expect(() => localPermission(undefined)).toThrow()
})
it('rejects attaching or delivering another workspace or permission into a local worker', () => {
  const origin = localWorkTrigger(input)
  expect(() => validateLocalInput(origin, localWorkTrigger({ ...input, eventId: 'evt2', workspace: 'F:\\Other' }))).toThrow(/workspace/i)
  expect(() => validateLocalInput(origin, localWorkTrigger({ ...input, eventId: 'evt3', permission: 'workspace-write', writeAuthorization: 'EXPLICIT_WORKSPACE_WRITE' }))).toThrow(/permission/i)
  expect(() => validateLocalInput(origin, localWorkTrigger({ ...input, eventId: 'evt4', workId: 'other-topic' }))).not.toThrow()
})
