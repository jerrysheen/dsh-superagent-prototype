import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Store } from '../src/app/store.ts'
import { ContextCatalog } from '../src/app/context-catalog.ts'
import { ContextTargets } from '../src/app/context-targets.ts'
import { TargetResolver } from '../src/app/target-resolver.ts'
let root: string, store: Store, targets: ContextTargets
const id = '01a1a0f6-353d-7581-b6dd-077563be0280', uid = 'codex:' + id
const model = { provider: 'openai', model: 'gpt-6-luna' }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolver-')); store = new Store(join(root, 'state.sqlite'))
  const catalog = new ContextCatalog(store)
  catalog.importMetadata({ entries: [{ provider: 'codex', nativeThreadId: id, cwd: 'F:\\Projects\\Example',
    sourceKind: 'vscode', title: 'WASM 代码内存膨胀', createdAt: 1, updatedAt: 2, archived: false }] })
  targets = new ContextTargets(catalog, store)
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
function harness(steps: { name: string; args: unknown }[][]) {
  const calls: GenerateOptions[] = []
  const resolver = new TargetResolver(targets, { model: () => model, timeoutMs: () => 10000, lifetime: new AbortController().signal,
    llm: { async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(options)
      for (const [index, step] of (steps[calls.length - 1] ?? []).entries()) yield {
        type: 'tool-call-delta', index, id: ('call-' + calls.length + '-' + index) as never, name: step.name, argumentsDelta: JSON.stringify(step.args),
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } } })
  return { resolver, calls }
}
const finish = (edit: object = {}) => ({ name: 'finish_target', args: { intent: 'resume_existing', uid, projectId: null, candidates: [],
  reason: '该会话明确覆盖代码内存膨胀。', evidence: { userQuote: '代码内存', cardQuote: 'WASM 代码内存膨胀' }, ...edit } })
it('executes real tool-call messages, expands queries and returns a current binding without creating work', async () => {
  const { resolver, calls } = harness([
    [{ name: 'search_sessions', args: { query: '代码占用翻几倍', expansions: ['代码内存膨胀'] } }],
    [{ name: 'get_context_card', args: { uid } }, { name: 'get_work_binding', args: { uid } }], [finish()],
  ])
  const result = await resolver.resolve({ query: '继续代码内存那个问题' })
  expect(result).toMatchObject({ action: 'selected', target: { card: { uid }, binding: { kind: 'native-session', executable: true } } })
  expect(calls[0]?.tools?.map(t => t.name)).toContain('search_sessions')
  expect(calls[1]?.messages.some(m => m.role === 'tool')).toBe(true)
  expect(store.tickets.list()).toHaveLength(0)
})
it('returns indexed project targets for explicit new sessions instead of reusing history', async () => {
  const projectId = targets.projects({ query: 'Example' })[0]!.id
  const { resolver } = harness([[{ name: 'search_projects', args: { query: 'Example' } }],
    [finish({ intent: 'create_new', uid: null, projectId, evidence: null })]])
  expect(await resolver.resolve({ query: '在 Example 新开一条会话研究 WASM' })).toMatchObject({ action: 'create_new', target: { kind: 'new', project: { id: projectId } } })
})
it('does not select invented/uninspected targets and does not call unknown tools', async () => {
  const { resolver } = harness([[{ name: 'send_message', args: {} }], [finish()], []])
  const result = await resolver.resolve({ query: '继续代码内存' })
  expect(result.action).toBe('needs_confirmation')
  expect(result.toolTrace.map(t => t.error)).toContain('UNKNOWN_TOOL')
  expect(result.toolTrace.map(t => t.error)).toContain('INSUFFICIENT_EVIDENCE')
})
it('returns only searched candidates and refuses stale explicit user selections', async () => {
  const { resolver } = harness([[{ name: 'search_sessions', args: { query: '内存' } }],
    [finish({ intent: 'needs_confirmation', uid: null, candidates: [uid, 'invented'], evidence: null })]])
  expect((await resolver.resolve({ query: '上次那个内存问题' })).candidates.map(c => c.uid)).toEqual([uid])
  expect(() => resolver.select({ uid, fingerprint: 'old-version' })).toThrow('changed')
})
it('keeps an explicit new directive authoritative even if the model proposes a historical match', async () => {
  const { resolver } = harness([[{ name: 'get_context_card', args: { uid } }, { name: 'get_work_binding', args: { uid } }], [finish()], []])
  const result = await resolver.resolve({ query: '新开一条会话研究代码内存' })
  expect(result.action).toBe('needs_confirmation')
  expect(result.toolTrace.map(t => t.error)).toContain('EXPLICIT_NEW_WORK')
})
it('does not manufacture choices for a contextless follow-up and reuses a known current session directly', async () => {
  const { resolver, calls } = harness([])
  expect(await resolver.resolve({ query: '上次那个接着弄' })).toMatchObject({ action: 'needs_confirmation', candidates: [] })
  expect(await resolver.resolve({ query: '上次那个接着弄', currentSessionUid: uid })).toMatchObject({ action: 'selected', target: { card: { uid } } })
  expect(calls).toHaveLength(0)
})
it('does not reuse the current session when a pure follow-up explicitly names a different project', async () => {
  new ContextCatalog(store).importMetadata({ entries: [{ provider: 'codex', nativeThreadId: '01a1a178-e245-74b3-b1c5-ea74d36a3a65',
    cwd: 'F:\\OtherProject', title: '另一个工程的工作', sourceKind: 'vscode', archived: false, createdAt: 1, updatedAt: 2 }] })
  const { resolver } = harness([])
  for (const query of ['继续 OtherProject', '继续 otherproject', '继续 Example 和 OtherProject']) {
    const result = await resolver.resolve({ query, currentSessionUid: uid })
    expect(result.action).toBe('needs_confirmation'); expect(result.target).toBeNull()
    if (!query.includes('Example')) expect(result.candidates.every(card => card.projectName === 'OtherProject')).toBe(true)
  }
})
