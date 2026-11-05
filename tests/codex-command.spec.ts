import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { codexCommand } from '../src/app/codex-local-client.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-command-')); directories.push(directory)
  const desktop = join(directory, 'OpenAI', 'Codex', 'bin', 'current'), npm = join(directory, 'npm')
  mkdirSync(desktop, { recursive: true }); mkdirSync(npm)
  writeFileSync(join(desktop, 'codex.exe'), ''); writeFileSync(join(npm, 'codex.cmd'), '')
  return { directory, desktop, environment: { LOCALAPPDATA: directory, APPDATA: directory, PATH: npm } }
}
it('prefers the desktop app binary over an older npm shim', () => {
  const { desktop, environment } = fixture()
  expect(codexCommand(['app-server'], environment)).toEqual({ file: join(desktop, 'codex.exe'), args: ['app-server'] })
})
it('honors an explicit binary and fails closed for a missing override', () => {
  const { desktop, environment } = fixture()
  expect(codexCommand([], { ...environment, CODEX_APP_SERVER_EXE: join(desktop, 'codex.exe') }).file).toBe(join(desktop, 'codex.exe'))
  expect(() => codexCommand([], { ...environment, CODEX_CLI_PATH: join(desktop, 'missing.exe') })).toThrow('未回退')
})
it('selects the most recently installed desktop binary deterministically', () => {
  const { directory, desktop, environment } = fixture(), newer = join(directory, 'OpenAI', 'Codex', 'bin', 'newer')
  mkdirSync(newer); writeFileSync(join(newer, 'codex.exe'), '')
  utimesSync(join(desktop, 'codex.exe'), 1, 1); utimesSync(join(newer, 'codex.exe'), 2, 2)
  expect(codexCommand([], environment).file).toBe(join(newer, 'codex.exe'))
})
