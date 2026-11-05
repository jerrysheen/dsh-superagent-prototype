/** Windows-native CLI resolution, script hosts, and descendant-aware cancellation. */
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

export const windowsSystem = (name: string): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
export const powershell = (): string => windowsSystem('WindowsPowerShell\\v1.0\\powershell.exe')
/** Windows names environment variables without regard to case; plain object spreads do not. */
export function mergeEnvironment(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing]
    if (value !== undefined) env[key] = value
  }
  return env
}
export function findExecutable(name: string, path = process.env.PATH ?? ''): string | undefined {
  const extensions = extname(name) ? [''] : [...new Set([...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.toLowerCase()).filter(Boolean), '.ps1'])]
  const directories = isAbsolute(name) ? [''] : path.split(delimiter).map(dir => dir.replace(/^"|"$/g, '')).filter(isAbsolute)
  for (const dir of directories) for (const extension of extensions) {
    const candidate = dir ? join(dir, name + extension) : name + extension
    try { if (statSync(candidate).isFile()) return realpathSync(candidate) } catch { /* Try the next executable. */ }
  }
}
/** Script paths and argv are data in an encoded PowerShell program, never interpolated shell syntax. */
export function nativeCommand(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const file = findExecutable(program, env.PATH ?? env.Path) ?? program
  return scriptCommand(file, args, powershell(), windowsSystem('cmd.exe'), windowsSystem('WindowsPowerShell\\v1.0\\Modules'))
}
/** Kept self-contained so generated worker launchers use exactly the same argv handling. */
function scriptCommand(file: string, args: readonly string[], ps: string, cmd: string, modules: string): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const quotePs = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
  if (!/\.(?:cmd|bat|ps1)$/i.test(file)) return { file, args: [...args] }
  if (/\.(?:cmd|bat)$/i.test(file)) {
    // cmd parses twice for a batch shim: escape its syntax at both boundaries,
    // in addition to quoting backslashes/double quotes for the final executable.
    const meta = /([()%!^"<>&|;, *?])/g
    const escape = (value: string) => ('"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"').replace(meta, '^$1').replace(meta, '^$1')
    const command = '"' + file.replace(meta, '^$1') + ' ' + args.map(escape).join(' ') + '"'
    return { file: cmd, args: ['/d', '/s', '/c', command], windowsVerbatimArguments: true }
  }
  const payload = Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false; $env:PSModulePath=" + quotePs(modules) + "; $a=[string[]](ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')))); & " + quotePs(file) + " @a; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"
  return { file: ps, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}
export function nativeLauncher(program: string | undefined, failure: string, directory: string, variables: Record<string, string | undefined>): string {
  return `const {spawnSync}=require('node:child_process'); const {realpathSync}=require('node:fs'); const {resolve,delimiter}=require('node:path');
const config=${JSON.stringify({ program, failure, directory, variables, unset: Object.keys(variables).filter(key => variables[key] === undefined) })};
if(!config.program){console.error(config.failure);process.exit(1)}
const canonical=p=>{try{return realpathSync(p).toLowerCase()}catch{return resolve(p).toLowerCase()}};
const env={...process.env};for(const key of [...Object.keys(config.variables),...config.unset]){for(const existing of Object.keys(env))if(existing.toUpperCase()===key.toUpperCase())delete env[existing];if(config.variables[key]!==undefined)env[key]=config.variables[key]}
env.PATH=(process.env.PATH||'').split(delimiter).filter(p=>canonical(p)!==canonical(config.directory)).join(delimiter);
const launch=(${scriptCommand.toString()})(config.program,process.argv.slice(2),${JSON.stringify(powershell())},${JSON.stringify(windowsSystem('cmd.exe'))},${JSON.stringify(windowsSystem('WindowsPowerShell\\v1.0\\Modules'))});
const result=spawnSync(launch.file,launch.args,{env,stdio:'inherit',windowsHide:true,windowsVerbatimArguments:launch.windowsVerbatimArguments});
if(result.error){console.error('Configured account CLI could not run: '+result.error.code);process.exit(1)}process.exit(result.status??1);
`
}
/** DSH's argv port has no verbatim-command-line flag; a Node bridge preserves cmd's escaping. */
export function subprocessCommand(program: string, args: readonly string[], env?: NodeJS.ProcessEnv): string[] {
  const launch = nativeCommand(program, args, env)
  if (!launch.windowsVerbatimArguments) return [launch.file, ...launch.args]
  const payload = Buffer.from(JSON.stringify(launch), 'utf8').toString('base64')
  return [process.execPath, '-e', `const c=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));const r=require('node:child_process').spawnSync(c.file,c.args,{stdio:'inherit',windowsHide:true,windowsVerbatimArguments:true});if(r.error){console.error('Native command could not run: '+r.error.code);process.exit(1)}process.exit(r.status??1)`, payload]
}
/** Kill the tree before its parent exits; terminating a wrapper alone leaves its CLI running. */
export function stopNative(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return Promise.resolve() }
  return new Promise(resolve => {
    execFile(windowsSystem('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { resolve() })
  })
}
export async function execNative(program: string, args: readonly string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const invocation = nativeCommand(program, args, options.env)
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let aborted = false, timedOut = false, overflow = false
    const child = execFile(invocation.file, invocation.args, { ...options, maxBuffer: Infinity, windowsVerbatimArguments: invocation.windowsVerbatimArguments, signal: undefined, timeout: undefined, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      if (aborted) { reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); return }
      if (timedOut) { reject(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM', stderr })); return }
      if (overflow) { reject(Object.assign(new Error('Command exceeded its output limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: '' })); return }
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
    const abort = () => { aborted = true; void stopNative(child) }
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0
      stream?.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (!overflow && bytes > (options.maxBuffer ?? 1024 * 1024)) { overflow = true; void stopNative(child) }
      })
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = options.timeout ? setTimeout(() => { timedOut = true; void stopNative(child) }, options.timeout) : undefined
    timer?.unref()
    if (options.signal?.aborted) abort()
  })
}
