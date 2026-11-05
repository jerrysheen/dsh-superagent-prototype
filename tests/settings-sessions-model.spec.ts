import { expect, it, vi } from 'vitest'
import { Settings } from '../src/app/settings.ts'
import { SettingsSchema } from '../src/policy.ts'

/** Sessions coordination does not need a repository Setup deployment. */
it('switches the Eval model without restarting a sessions-mode DSH host', async () => {
  let current = SettingsSchema.parse({
    paused: true,
    eval: { mode: 'observe', timeoutSeconds: 120,
      model: { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'medium' } },
  })
  let revision = 0
  const restart = vi.fn()
  const requestPass = vi.fn()
  const host = {
    store: {
      settings: () => current,
      saveSettings: (value: typeof current) => { current = value; revision++ },
      blockRevision: () => revision,
      atomic: <T>(work: () => T): T => work(),
      tickets: { open: () => [] },
      get: () => 0,
    },
    sources: { scope: () => ({ listened: false }) },
    sourceHost: { configured: () => true },
    setup: { configured: () => false, checkAccounts: vi.fn(), blockCommands: vi.fn(), restart },
    sessions: { notify: vi.fn(), delivery: vi.fn().mockResolvedValue('pending') },
    context: { llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) } },
    engine: { policyChanged: vi.fn() },
    lifetime: new AbortController().signal,
    requestPass,
  }
  const settings = new Settings(host as never)
  const result = await settings.save('eval', {
    ...current.eval, model: { provider: 'openai', model: 'gpt-6.1-terra', reasoningEffort: 'medium' },
  }, revision, 'panel')
  expect(result).toMatchObject({ saved: true, restarting: false })
  expect(restart).not.toHaveBeenCalled()
  expect(requestPass).toHaveBeenCalledOnce()
  expect(current.eval.model).toMatchObject({ model: 'gpt-6.1-terra', reasoningEffort: 'medium' })
  expect(current.paused).toBe(true)
})
