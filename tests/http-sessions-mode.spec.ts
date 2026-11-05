import { expect, it } from 'vitest'
import { registerHttp, stateView, type HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'

/** Regression: sessions-mode Runtime intentionally skips repository deployment setup. */
it('serves management state for sessions mode without reading unresolved deployment', async () => {
  const settings = SettingsSchema.parse({})
  const runtime = {
    store: { settings: () => settings, tickets: { open: () => [] } },
    machine: {
      coordinationMode: 'sessions',
      stateDir: 'F:\\Github\\DSHSuperAgent\\.local\\state\\superagent',
      promptMaxChars: { get: () => 20000 },
      admissionContextMaxPages: { get: () => 5 },
      admissionContextTimeoutMs: { get: () => 25000 },
    },
    configured: () => true,
    get deployment(): never { throw new Error('Unresolved repository deployment must not be accessed') },
    executor: { activeCount: () => 0 },
    health: { runtime: { state: 'ready', detail: 'Session coordinator ready' } },
    masterId: 'local-session-coordinator',
    ready: Promise.resolve(),
  }
  const view = stateView(runtime as unknown as HttpHost)
  expect(view).toMatchObject({ coordinationMode: 'sessions', setup: { accounts: null },
    health: { runtime: { state: 'ready' } } })
  expect(view.setup.machine.stateDir).toContain('superagent')

  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  const ctx = { webServer: { host: '127.0.0.1', port: 3082,
    register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
      handler = route.handler
      return () => {}
    } } }
  registerHttp(ctx as never, runtime as unknown as HttpHost)
  let status = 0, body = ''
  await handler!({ method: 'GET', url: '/orchestrator/api/state',
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } },
  { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } })
  expect(status).toBe(200)
  expect(JSON.parse(body)).toMatchObject({ coordinationMode: 'sessions', setup: { accounts: null } })
})
