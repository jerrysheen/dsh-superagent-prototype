import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { toolOutput } from '../src/app/tool-output.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { SettingsSchema } from '../src/policy.ts'
import { readProjectProgress } from '../src/app/project-progress.ts'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
async function pipeline() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  let call = 0
  return { tools: ctx.tools, execute: (name: string, args: unknown = {}) => ctx.tools.execute({
    callId: ToolCallId('output-test-' + ++call), name, arguments: args, signal: new AbortController().signal,
  }) }
}
function workspace() {
  const path = mkdtempSync(join(tmpdir(), 'tool-output-'))
  cleanup.push(() => { if (!resolve(path).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe cleanup'); rmSync(path, { recursive: true, force: true }) })
  mkdirSync(join(path, 'docs'))
  return path
}
const record = { version: 1, asOf: '2026-11-05', coverage: 'Synthetic repository evidence, not all history',
  entries: [{ id: 'image-input', summary: 'Synthetic image implementation already verified before intake', status: 'verified',
    evidence: ['docs/MODEL_INPUT_ACCEPTANCE.md'], limitations: 'Browser interaction pending' }] }

it('reproduces both rejected outputs in the installed real DSH pipeline and accepts normalized values', async () => {
  const { tools, execute } = await pipeline()
  const definition = (name: string, value: unknown): ToolDefinition => ({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute: async () => value })
  tools.register(definition('undefined_output', { works: [{ optional: undefined }] }))
  tools.register(definition('array_output', [{ uid: 'codex:synthetic' }]))
  expect(await execute('undefined_output')).toMatchObject({ isError: true,
    error: { message: expect.stringContaining('value is not lossless JSON') } })
  expect(await execute('array_output')).toMatchObject({ isError: true,
    error: { message: expect.stringContaining('must be an object') } })
  tools.register(definition('fixed_list', toolOutput([{ uid: 'codex:synthetic', optional: undefined }])))
  expect(await execute('fixed_list')).toMatchObject({ isError: false, value: { items: [{ uid: 'codex:synthetic' }] } })
})

it('runs actual master tool registrations through DSH validation for pending work, project references and pre-intake progress', async () => {
  const path = workspace()
  writeFileSync(join(path, 'docs', 'PROJECT_PROGRESS.json'), JSON.stringify(record))
  const h = await startRuntime(store => store.saveSettings(SettingsSchema.parse({ paused: true,
    sources: { github: { enabled: false }, feishu: { enabled: false }, 'local-work': { config: { workspaces: [{ path }] } } },
  })), { coordinationMode: 'sessions', sessionExecution: false })
  cleanup.push(() => h.stop())
  new ContextCatalog(h.runtime.store).importMetadata({ entries: [{ provider: 'codex',
    nativeThreadId: '01a1a0f6-353d-7581-b6dd-077563be0280', title: 'Synthetic image work', cwd: path,
    sourceKind: 'vscode', createdAt: 1, updatedAt: 2, archived: false }] })
  await h.api('POST', 'master/open')
  await h.sessionApi('POST', 'managed-work/prepare', { mode: 'new', workspace: path, instruction: '只读合成草案' })
  const { tools, execute } = await pipeline()
  for (const definition of h.tools.get(h.runtime.masterId)!.values()) tools.register(definition as unknown as ToolDefinition)
  const threadId = '01a1a0f6-353d-7581-b6dd-077563be0280'
  await h.sessionApi('POST', 'activity/observe', { observedAt: new Date().toISOString(), sessions: [{ threadId, workspace: path, state: 'idle' }] })
  expect(await execute('get_session_activity', { threadId, format: 'uuid' })).toMatchObject({ isError: false, value: { threadId, state: 'idle' } })
  for (const args of [{ threadId: 'invalid', format: 'uuid' }, { threadId, format: 'other' }, { threadId, unrelated: true }]) {
    expect(await execute('get_session_activity', args)).toMatchObject({ isError: true })
  }
  const projects = await execute('search_projects', { query: '' })
  expect(projects.isError, JSON.stringify(projects)).toBe(false)
  const projectId = (projects.value as any).items[0].id
  expect(await execute('get_context_card', { uid: projectId })).toMatchObject({ isError: false,
    value: { kind: 'project', uid: projectId, completeProjectHistory: false } })
  expect(await execute('get_work_binding', { uid: projectId })).toMatchObject({ isError: false,
    value: { error: 'project_is_not_a_session' } })
  expect(await execute('search_sessions', { query: 'image', projectId })).toMatchObject({ isError: false,
    value: { items: [{ title: 'Synthetic image work' }] } })
  expect(await execute('list_managed_work', { projectId })).toMatchObject({ isError: false,
    value: { works: [], proposals: [{ state: 'draft' }], coverage: { completeProjectHistory: false } } })
  expect(await execute('read_project_progress', { projectId })).toMatchObject({ isError: false,
    value: { available: true, grantsExecution: false, entries: [{ id: 'image-input', status: 'verified' }] } })
  expect(await execute('read_project_progress', { workspace: join(path, 'elsewhere') })).toMatchObject({ isError: true })
  expect(await execute('list_managed_work', { projectId, workspace: 'F:\\Unrelated' })).toMatchObject({ isError: true })
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  expect(h.runtime.machine.sessionExecution).toBe(false)
})

it('bounds evidence to the fixed file and keeps absent progress distinct from no work', async () => {
  const path = workspace()
  expect(await readProjectProgress(path)).toMatchObject({ available: false, completeProjectHistory: false })
  const file = join(path, 'docs', 'PROJECT_PROGRESS.json')
  writeFileSync(file, JSON.stringify({ ...record, entries: [{ ...record.entries[0], evidence: ['../.local/private'] }] }))
  await expect(readProjectProgress(path)).rejects.toThrow()
  writeFileSync(file, ' '.repeat(65537))
  await expect(readProjectProgress(path)).rejects.toThrow('bounded file')
  rmSync(file)
  const other = workspace()
  writeFileSync(join(other, 'progress.json'), JSON.stringify(record))
  // Windows junctions require no elevated file-symlink privileges.
  rmSync(join(path, 'docs'), { recursive: true })
  symlinkSync(other, join(path, 'docs'), 'junction')
  writeFileSync(join(other, 'PROJECT_PROGRESS.json'), JSON.stringify(record))
  await expect(readProjectProgress(path)).rejects.toThrow('redirected path')
  unlinkSync(join(path, 'docs'))
})

it('rejects non-JSON values rather than silently corrupting tool evidence', () => {
  for (const value of [NaN, Infinity, 1n, new Date(), [undefined], () => 1]) expect(() => toolOutput(value)).toThrow()
  const cycle: any = {}; cycle.self = cycle
  expect(() => toolOutput(cycle)).toThrow('Cyclic')
  expect(toolOutput({ optional: undefined, nested: { optional: undefined, empty: null }, enabled: false }))
    .toEqual({ nested: { empty: null }, enabled: false })
})
