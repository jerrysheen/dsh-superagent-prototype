import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionRouter, routingInputHash, type RoutingInput } from '../src/app/session-router.ts'
import { SessionHub, TaskRequestSchema, type SessionCard } from '../src/app/session-hub.ts'
import { Store } from '../src/app/store.ts'

const card = (uid: string, title: string): SessionCard => ({ uid, title, summary: title, provider: 'test', surface: 'chatgpt', mode: 'work',
  projectId: 'test-project', projectName: 'Test project', threadId: `private-native-${uid}`, scope: 'unknown', identity: 'operator_confirmed',
  capabilities: { read: 'import', send: 'user' }, evidence: ['private-evidence-path'], origin: 'test' })
const model = { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'medium' }
const input = (): RoutingInput => ({ request: TaskRequestSchema.parse({ requestId: 'route', instruction: '继续处理 GC Profiler 问题' }),
  cards: [card('gc', 'GC Profiler allocation study'), card('shader', 'Shader compilation')], tasks: [] })
const proposal = { action: 'select', target_session_uid: 'gc', reason: 'GC Profiler 会话与任务的分析主题一致。' }
function harness(output: unknown = proposal, gate?: Promise<void>) {
  const calls: GenerateOptions[] = [], lifetime = new AbortController()
  const llm = { async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    calls.push(options)
    if (gate) await gate
    yield { type: 'text-delta', index: 0, text: typeof output === 'string' ? output : JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  return { calls, lifetime, router: new SessionRouter({ llm, model: () => model, timeoutMs: () => 1000, lifetime: lifetime.signal }) }
}

it('asks the DSH model for a semantic recommendation and records the reason without offering tools or histories', async () => {
  const { router, calls } = harness(), request = input()
  const decision = await router.recommend(request)
  expect(decision).toMatchObject({ action: 'selected', targetSessionUid: 'gc', model, reason: proposal.reason })
  expect(decision.inputHash).toBe(routingInputHash(request))
  expect(calls).toHaveLength(1); expect(calls[0]!.tools).toEqual([])
  const context = JSON.stringify(calls[0]!.messages)
  expect(context).toContain('GC Profiler'); expect(context).not.toContain('private-native'); expect(context).not.toContain('private-evidence')
})
it('retains the model clarification instead of defaulting to the first candidate', async () => {
  const { router } = harness({ action: 'needs_confirmation', target_session_uid: null, reason: '两个会话都涉及同一分析，请指定项目。' })
  expect(await router.recommend(input())).toMatchObject({ action: 'needs_confirmation', targetSessionUid: null, reason: expect.stringContaining('指定项目') })
})
it('rejects invented targets, unavailable capabilities and unknown modes even when the model selects them', async () => {
  for (const edit of ['missing', 'identity', 'mode', 'capability']) {
    const request = input(), { router } = harness(edit === 'missing' ? { ...proposal, target_session_uid: 'invented' } : proposal)
    if (edit === 'identity') request.cards[0]!.identity = 'unknown'
    if (edit === 'mode') request.cards[0]!.mode = 'unknown'
    if (edit === 'capability') request.cards[0]!.capabilities.send = 'unavailable'
    expect(await router.recommend(request)).toMatchObject({ action: 'needs_confirmation', targetSessionUid: null, errorCode: 'INELIGIBLE_TARGET' })
  }
})
it('does not route on malformed output or a missing model and does not silently truncate oversized candidate sets', async () => {
  expect(await harness('not-json').router.recommend(input())).toMatchObject({ action: 'needs_confirmation', errorCode: 'ROUTING_FAILED' })
  const { router, calls } = harness(), large = input(); large.cards = Array.from({ length: 31 }, (_, index) => card(String(index), 'GC'))
  expect(await router.recommend(large)).toMatchObject({ action: 'needs_confirmation', errorCode: 'ROUTING_INPUT_LIMIT' }); expect(calls).toHaveLength(0)
  const disabled = new SessionRouter({ llm: { async *stream() { throw new Error('Must not run') } }, model: () => null,
    timeoutMs: () => 1000, lifetime: new AbortController().signal })
  expect(await disabled.recommend(input())).toMatchObject({ action: 'needs_confirmation', errorCode: 'MODEL_NOT_CONFIGURED' })
})
it('fails closed on model cancellation and unexpected tool calls', async () => {
  const lifetime = new AbortController()
  const cancelled = new SessionRouter({ llm: { async *stream() {
    lifetime.abort(); yield { type: 'finish', reason: { kind: 'stop' } }
  } }, model: () => model, timeoutMs: () => 1000, lifetime: lifetime.signal })
  expect(await cancelled.recommend(input())).toMatchObject({ action: 'needs_confirmation', errorCode: 'ROUTING_CANCELLED' })
  const tool = new SessionRouter({ llm: { async *stream() {
    yield { type: 'tool-call-delta', index: 0, id: 'call' as never, name: 'send', argumentsDelta: '{}' }
  } }, model: () => model, timeoutMs: () => 1000, lifetime: new AbortController().signal })
  expect(await tool.recommend(input())).toMatchObject({ action: 'needs_confirmation', errorCode: 'UNEXPECTED_TOOL_CALL' })
})

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'router-')); store = new Store(join(directory, 'state.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
it('runs the Router for natural-language task submission and persists its selected target and explanation', async () => {
  const { router } = harness(), hub = new SessionHub(store, router)
  for (const item of input().cards) hub.register(item)
  const task = await hub.submitRouted({ requestId: 'one', instruction: '继续处理 GC Profiler 问题' })
  expect(task).toMatchObject({ status: 'waiting_user', target: { uid: 'gc' }, routing: { action: 'selected', model } })
  expect(task.receipts).toEqual([])
  store.close(); store = new Store(join(directory, 'state.sqlite'))
  expect(new SessionHub(store).snapshot().tasks[0]!.routing?.reason).toBe(proposal.reason)
})
it('deduplicates simultaneous and completed routing requests without another model call', async () => {
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve })
  const { router, calls } = harness(proposal, gate), hub = new SessionHub(store, router)
  for (const item of input().cards) hub.register(item)
  const request = { requestId: 'one', instruction: '继续处理 GC Profiler 问题' }
  const first = hub.submitRouted(request), second = hub.submitRouted(request)
  expect(first).toBe(second)
  await expect(hub.submitRouted({ ...request, instruction: 'Different' })).rejects.toThrow('requestId')
  release(); const saved = await first
  expect((await hub.submitRouted(request)).id).toBe(saved.id); expect(calls).toHaveLength(1)
})
it('rejects a stale recommendation when session summaries change during inference', async () => {
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve })
  const { router } = harness(proposal, gate), hub = new SessionHub(store, router)
  for (const item of input().cards) hub.register(item)
  const result = hub.submitRouted({ requestId: 'one', instruction: '继续处理 GC Profiler 问题' })
  hub.register({ ...input().cards[0]!, summary: 'Different current topic' }); release()
  expect(await result).toMatchObject({ status: 'needs_target', target: null, routing: { errorCode: 'ROUTING_CONTEXT_CHANGED' } })
})
it('does not spend model tokens for an explicitly chosen target or fall back to a sole unrelated session when no Router is configured', async () => {
  const { router, calls } = harness(), hub = new SessionHub(store, router)
  hub.register(input().cards[0]!)
  expect((await hub.submitRouted({ requestId: 'exact', instruction: 'Test', target: { uid: 'gc' } })).target?.uid).toBe('gc')
  expect(calls).toHaveLength(0)
  expect(await new SessionHub(store).submitRouted({ requestId: 'natural', instruction: 'Book a flight' })).toMatchObject({ status: 'needs_target', target: null })
})
