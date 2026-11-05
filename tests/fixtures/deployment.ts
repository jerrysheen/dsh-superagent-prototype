/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})

/** Identify workspace prepare launches independently of command contents. */
export const isPrepare = (argv: readonly string[]): boolean => process.platform === 'win32'
  ? /[\\/]powershell\.exe$/i.test(argv[0] ?? '') && argv.includes('-Command') : argv[0] === 'sh'
/** Fixture response keys preserve the configured command after the shell's error/exit wrapper. */
export function workerCommandKey(argv: readonly string[]): string {
  if (isPrepare(argv)) return 'prepare ' + (process.platform === 'win32' ? argv.at(-1)!.split('\n').slice(1, -1).join('\n') : argv[2])
  const normalized = [...argv]
  if (/[\\/]git(?:\.exe)?$/i.test(normalized[0] ?? '')) normalized[0] = 'git'
  return normalized.join(' ')
}
