import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SessionHub, type SessionCard } from '../src/app/session-hub.ts'
import { registerSessionHub } from '../src/app/session-hub-http.ts'

let directory: string, store: Store, hub: SessionHub
const card = (uid: string, projectId: string, mode: 'chat' | 'work' = 'work'): SessionCard => ({
  uid, provider: 'test', surface: 'chatgpt', mode, projectId, projectName: projectId, title: 'Same title', threadId: uid,
  scope: 'unknown', summary: '', identity: 'operator_confirmed', capabilities: { read: 'import', send: 'user' }, evidence: ['test fixture'], origin: 'test',
})
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'session-hub-')); store = new Store(join(directory, 'state.sqlite')); hub = new SessionHub(store) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('separates projects and Chat/Work despite identical titles, without sending anything', () => {
  hub.register(card('a-work', 'a')); hub.register(card('b-work', 'b')); hub.register(card('a-chat', 'a', 'chat'))
  const task = hub.submit({ requestId: 'one', instruction: 'Run a test', target: { projectId: 'a', mode: 'work' } })
  expect(task.target?.uid).toBe('a-work'); expect(task.status).toBe('waiting_user'); expect(task.receipts).toEqual([])
  expect(hub.submit({ requestId: 'two', instruction: 'Run a test', target: { projectId: 'a' } }).status).toBe('needs_target')
})
it('refuses unconfirmed identities, missing targets and unavailable send capabilities', () => {
  hub.register({ ...card('unknown', 'a'), identity: 'unknown' })
  expect(hub.submit({ requestId: 'unknown', instruction: 'Test', target: { uid: 'unknown' } }).status).toBe('needs_target')
  expect(hub.submit({ requestId: 'missing', instruction: 'Test', target: { uid: 'missing' } }).target).toBeNull()
  hub.register({ ...card('off', 'b'), capabilities: { read: 'unavailable', send: 'unavailable' } })
  expect(hub.submit({ requestId: 'off', instruction: 'Test', target: { uid: 'off' } }).status).toBe('unavailable')
})

it('accepts an explicitly selected machine-confirmed native thread without guessing its Chat/Work mode', () => {
  hub.register({ ...card('native', 'a'), mode: 'unknown', identity: 'machine_confirmed' })
  expect(hub.submit({ requestId: 'explicit', instruction: 'Test', target: { uid: 'native' } }).status).toBe('waiting_user')
  expect(hub.submit({ requestId: 'inferred', instruction: 'Test', target: { projectId: 'a' } }).status).toBe('needs_target')
  hub.register({ ...card('manual', 'b'), mode: 'unknown' })
  expect(hub.submit({ requestId: 'manual', instruction: 'Test', target: { uid: 'manual' } }).status).toBe('needs_target')
})
it('keeps request and receipt idempotency keys bound to the original payload and target', () => {
  hub.register(card('a', 'a'))
  const input = { requestId: 'one', instruction: 'Test', target: { uid: 'a' } }, task = hub.submit(input)
  expect(hub.submit(input).id).toBe(task.id)
  expect(() => hub.submit({ ...input, instruction: 'Different' })).toThrow('requestId')
  const event = { eventId: 'sent', sessionUid: 'a', status: 'submitted', actor: 'user' }
  hub.receipt(task.id, event); hub.receipt(task.id, event)
  expect(hub.snapshot().tasks[0]!.receipts).toHaveLength(1)
  expect(() => hub.receipt(task.id, { ...event, eventId: 'wrong', sessionUid: 'b' })).toThrow('does not match')
  expect(() => hub.receipt(task.id, { ...event, status: 'running' })).toThrow('eventId')
})
it('does not equate a reply or a completion claim with verified completion', () => {
  hub.register(card('a', 'a'))
  const task = hub.submit({ requestId: 'one', instruction: 'Test', target: { uid: 'a' } })
  const base = { sessionUid: 'a', actor: 'user' }
  expect(hub.receipt(task.id, { ...base, eventId: 'reply', status: 'response_visible', result: 'Draft' }).status).toBe('response_visible')
  expect(hub.receipt(task.id, { ...base, eventId: 'ready', status: 'reported_ready' }).status).toBe('reported_ready')
  expect(() => hub.receipt(task.id, { ...base, eventId: 'verify', status: 'verified_done' })).toThrow('evidence')
  expect(() => hub.receipt(task.id, { ...base, actor: 'connector', eventId: 'verify', status: 'verified_done', evidence: ['file'] })).toThrow('user verification')
  expect(hub.receipt(task.id, { ...base, eventId: 'verify', status: 'verified_done', evidence: ['operator checked result'] }).status).toBe('verified_done')
})
it('preserves uncertain results and target snapshots across restart, without replaying a send', () => {
  hub.register(card('a', 'a'))
  const task = hub.submit({ requestId: 'one', instruction: 'Test', target: { uid: 'a' } })
  hub.receipt(task.id, { eventId: 'uncertain', sessionUid: 'a', status: 'uncertain', actor: 'user' })
  hub.register({ ...card('a', 'a'), title: 'Renamed' })
  store.close(); store = new Store(join(directory, 'state.sqlite')); hub = new SessionHub(store)
  expect(hub.snapshot().tasks[0]!.target?.title).toBe('Same title')
  expect(hub.snapshot().tasks[0]!.status).toBe('uncertain')
  expect(() => hub.receipt(task.id, { eventId: 'retry', sessionUid: 'a', status: 'submitted', actor: 'connector' })).toThrow('do not resend')
})
it('clears synthetic demo data without deleting user-registered sessions', () => {
  hub.register(card('test', 'test')); hub.register({ ...card('real', 'real'), origin: 'manual' })
  hub.submit({ requestId: 'test', instruction: 'Test', target: { uid: 'test' }, demo: true })
  hub.submit({ requestId: 'manual', instruction: 'Manual', target: { uid: 'real' } })
  expect(hub.clearDemo()).toEqual({ removedSessions: 1, removedTasks: 1 })
  expect(hub.snapshot().sessions.map(card => card.uid)).toEqual(['real'])
  expect(hub.snapshot().tasks).toHaveLength(1)
})

it('does not rebind a stable session uid to another project or mode', () => {
  hub.register(card('a', 'a'))
  expect(() => hub.register(card('a', 'b'))).toThrow('different identity')
  expect(() => hub.register(card('a', 'a', 'chat'))).toThrow('different identity')
  expect(hub.snapshot().sessions[0]!.projectId).toBe('a')
})

it('requires same-origin loopback requests and validates session API input', async () => {
  type Handler = (request: unknown, response: unknown) => Promise<void>
  let handle: Handler = async () => {}
  const context = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handle = route.handler; return () => {} } } }
  registerSessionHub(context as never, hub)
  const call = async (method: string, path: string, value?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, body = ''
    const request = { method, url: `/session-hub/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers },
      async *[Symbol.asyncIterator]() { if (value !== undefined) yield Buffer.from(JSON.stringify(value)) } }
    await handle(request, { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } })
    return { status, body: JSON.parse(body) }
  }
  expect((await call('GET', 'snapshot', undefined, { origin: 'http://untrusted.example' })).status).toBe(403)
  expect((await call('GET', 'snapshot', undefined, { 'x-orchestrator-request': undefined })).status).toBe(403)
  expect((await call('POST', 'sessions', {})).status).toBe(400)
  expect((await call('POST', 'sessions', card('http', 'a'))).status).toBe(200)
  expect((await call('GET', 'snapshot')).body.sessions).toHaveLength(1)
})
