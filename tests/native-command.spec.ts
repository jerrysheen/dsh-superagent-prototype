import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { execNative, findExecutable, mergeEnvironment, subprocessCommand } from '../src/infra/native-command.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('resolves PATHEXT and executes trusted cmd/ps1 hosts from paths with spaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native command ')); dirs.push(dir)
  const script = join(dir, 'argv.cjs'); writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
  const cmd = join(dir, 'fixture.cmd'); writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n')
  const ps = join(dir, 'fixture.ps1'); writeFileSync(ps, 'ConvertTo-Json -Compress -InputObject @($args)')
  expect(findExecutable('fixture', dir)?.toLowerCase()).toBe(cmd.toLowerCase())
  writeFileSync(join(dir, 'fixture'), '#!/bin/sh\nexit 99')
  expect(findExecutable('fixture', dir)?.toLowerCase()).toBe(cmd.toLowerCase())
  for (const file of [cmd, ps]) {
    const args = ['space value', '中文', 'a&b', '$(whoami)', '%PATH%', 'back`tick', 'quote"value', '']
    expect(JSON.parse((await execNative(file, args)).stdout), file).toEqual(args)
  }
  const args = ['a&b', 'quote"value', '', '中文']
  const argv = subprocessCommand(cmd, args)
  expect(JSON.parse((await promisify(execFile)(argv[0]!, argv.slice(1))).stdout)).toEqual(args)
})
it('merges account environment overrides case insensitively without retaining ambient aliases', () => {
  const env = mergeEnvironment({ gh_token: 'fixture', Path: 'old', GIT_AUTHOR_NAME: 'fixture' }, { GH_TOKEN: undefined, PATH: 'native', git_author_name: undefined })
  expect(Object.keys(env)).toEqual(['PATH'])
  expect(env.PATH).toBe('native')
})
it('cancels the native process tree, including a running Node descendant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native cancellation ')); dirs.push(dir)
  const marker = join(dir, 'child-started'), heartbeat = join(dir, 'heartbeat')
  const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30)`
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const controller = new AbortController()
  const running = execNative(process.execPath, ['-e', parent], { signal: controller.signal })
  const failure = running.catch(error => error)
  const deadline = Date.now() + 4000
  while (!existsSync(heartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  expect(existsSync(marker)).toBe(true); expect(existsSync(heartbeat)).toBe(true)
  controller.abort()
  expect(await failure).toMatchObject({ name: 'AbortError' })
  const before = readFileSync(heartbeat, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(readFileSync(heartbeat, 'utf8')).toBe(before)
}, 10000)
