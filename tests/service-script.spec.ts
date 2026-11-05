/** Native service policy tests: actual Node children, CIM process discovery and authenticated graceful stop. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
let root: string, profile: string, server: Server | undefined
let children: ChildProcess[] = []
const control = () => join(root, '.artifacts', 'control', 'profiles', profile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const READY = { health: { runtime: { state: 'ready' } }, setup: {} }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native service ')); profile = `fixture-${process.pid}-${Date.now()}`
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  for (const name of ['dsh-superagent.mjs', 'service-bridge.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', name), join(root, 'scripts', name))
  writeFileSync(join(root, 'bin', 'dsh.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'launched'))}, JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv}));
console.log('fixture log'); process.on('SIGINT', () => { if (!process.env.FIXTURE_HANG) setTimeout(() => process.exit(0), 100) }); setInterval(() => {}, 1000);`)
})
afterEach(async () => {
  server?.closeAllConnections(); server?.close(); server = undefined
  // Only synthetic children created by this test are terminated during cleanup.
  const record = join(control(), 'service.json')
  if (existsSync(record)) { const pid = JSON.parse(readFileSync(record, 'utf8')).pid; if (alive(pid)) process.kill(pid) }
  for (const child of children) child.kill()
  children = []; await sleep(150); rmSync(root, { recursive: true, force: true })
})
function run(...args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent.mjs'), ...args],
    { env: {...process.env, DSH_SUPERAGENT_PROFILE: profile, DSH_SUPERAGENT_URL: 'http://127.0.0.1:9'}, timeout: 30000 },
    (error, stdout, stderr) => resolve({code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr})))
}
async function answering(state: unknown = READY, always = false) {
  server = createServer((request, response) => {
    expect(request.headers['x-orchestrator-request']).toBe('1')
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(state))
  }); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const start = (url: string, ...args: string[]) => run('start', '--dsh-entry', join(root, 'bin', 'dsh.mjs'), '--url', url, '--timeout', '4', ...args)
const record = () => JSON.parse(readFileSync(join(control(), 'service.json'), 'utf8'))
async function external(...args: string[]) {
  const child = spawn(process.execPath, [join(root, 'bin', 'dsh.mjs'), ...args], {stdio:'ignore', windowsHide:true}); children.push(child)
  await sleep(250); return child.pid!
}
it('keeps intentional stop per profile and respects automatic recovery', async () => {
  expect(await run('stop')).toMatchObject({code:0,stdout:expect.stringContaining('Automatic recovery is paused')})
  expect(JSON.parse((await run('status')).stdout).manually_stopped).toBe(true)
  expect(JSON.parse((await run('status', '--profile', profile + '-other')).stdout).manually_stopped).toBe(false)
  expect(await run('start','--respect-stop')).toMatchObject({code:0,stdout:expect.stringContaining('Intentional stop is active')})
}, 30000)
it('starts native hidden child with literal spaced paths, persists PID and writes logs', async () => {
  const url = await answering(); expect(await start(url)).toMatchObject({code:0})
  const child = record(); expect(readFileSync(join(control(),'service.pid'),'utf8')).toBe(`${child.pid}\n`)
  const launched = JSON.parse(readFileSync(join(root,'launched'),'utf8'))
  expect(launched.cwd).toBe(root); expect(launched.args).toEqual(expect.arrayContaining(['--profile',profile,'--no-open']))
  expect(readFileSync(child.log,'utf8')).toContain('fixture log')
  expect(await start(url)).toMatchObject({code:0,stdout:expect.stringContaining('already running')})
  expect(record().pid).toBe(child.pid)
},30000)
it('refuses ambiguous profile processes before writing a stop marker', async () => {
  await external('--profile',profile); await external('--profile='+profile)
  expect(await run('stop')).toMatchObject({code:1,stderr:expect.stringContaining('Multiple dsh-superagent processes')})
  expect(existsSync(join(control(),'manually-stopped'))).toBe(false)
},30000)
it('filters plugin commands and unrelated Node commands from discovery', async () => {
  await external('plugin','--profile',profile,'add','link:/x')
  await external('--PROFILE='+profile)
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--profile',profile],{stdio:'ignore',windowsHide:true}); children.push(unrelated)
  const pid = await external('--profile',profile)
  expect(JSON.parse((await run('status')).stdout).pids).toEqual([pid])
},30000)
it('gracefully stops only its authenticated service and keeps unrelated processes alive',async()=>{
  const url=await answering(); expect(await start(url)).toMatchObject({code:0}); const pid=record().pid
  const other=await external('--profile',profile+'-other')
  expect(await run('stop','--stop-timeout','3')).toMatchObject({code:0})
  expect(alive(pid)).toBe(false); expect(alive(other)).toBe(true)
},30000)
it('retains newest twenty own logs without pruning other profiles',async()=>{
  mkdirSync(join(root,'.artifacts'),{recursive:true})
  for(const p of [profile,'other']) for(let i=0;i<25;i++) {
    const file=join(root,'.artifacts',`dsh-superagent-${p}-20260901-0000${String(i).padStart(2,'0')}-1.log`)
    writeFileSync(file,''); utimesSync(file,1700000000+i,1700000000+i)
  }
  expect(await start(await answering())).toMatchObject({code:0})
  const logs=readdirSync(join(root,'.artifacts')); expect(logs.filter(x=>x.startsWith(`dsh-superagent-${profile}-`))).toHaveLength(20)
  expect(logs.filter(x=>x.startsWith('dsh-superagent-other-'))).toHaveLength(25)
},30000)
it('accepts missing state keys and Feishu setup check failures while reporting runtime errors',async()=>{
  await external('--profile',profile)
  for(const [state,code] of [[{health:{runtime:{state:'ready'}}},0],[{health:{runtime:{state:'ready'}},setup:{feishuProblem:{detail:'No bot'}}},0],[{health:{runtime:{state:'error'}}},1]] as const){
    const url=await answering(state,true); expect(await run('status','--url',url)).toMatchObject({code}); server!.close(); server=undefined
  }
},30000)
it('reports component errors from status and start with exit 2',async()=>{
  await external('--profile',profile); const url=await answering({health:{runtime:{state:'ready'},source:{state:'error',detail:'bad config'}}},true)
  expect(await run('status','--url',url)).toMatchObject({code:2})
  expect(await start(url)).toMatchObject({code:2,stdout:expect.stringContaining('source reports an error, which a restart does not fix: bad config')})
},30000)
it('reports waiting setup with exit 3 from status and start',async()=>{
  await external('--profile',profile); const url=await answering({health:{runtime:{state:'paused'}},setup:{problem:{detail:'Configure source'}}},true)
  expect(await run('status','--url',url)).toMatchObject({code:3})
  expect(await start(url)).toMatchObject({code:3,stdout:expect.stringContaining('waiting for setup: Configure source')})
},30000)
it('restarts through graceful stop and launches a new native process',async()=>{
  const url=await answering(); expect(await start(url)).toMatchObject({code:0}); const pid=record().pid
  // Let the fixture readiness track the newly launched child, as a real server would.
  rmSync(join(root,'launched'))
  expect(await run('restart','--dsh-entry',join(root,'bin','dsh.mjs'),'--url',url,'--timeout','4','--stop-timeout','3')).toMatchObject({code:0})
  expect(record().pid).not.toBe(pid); expect(alive(pid)).toBe(false)
  expect(existsSync(join(control(),'manually-stopped'))).toBe(false)
},30000)
it('rejects concurrent profile operations while allowing another profile',async()=>{
  const child=spawn(process.execPath,[join(root,'scripts','dsh-superagent.mjs'),'start','--dsh-entry',join(root,'bin','dsh.mjs'),'--timeout','6'],{env:{...process.env,DSH_SUPERAGENT_PROFILE:profile,DSH_SUPERAGENT_URL:'http://127.0.0.1:9'},stdio:'ignore',windowsHide:true}); children.push(child)
  for(let i=0;i<100&&!existsSync(join(control(),'operation.lock'));i++) await sleep(50)
  expect(await run('status')).toMatchObject({code:1,stderr:expect.stringContaining('Another dsh-superagent control operation')})
  expect(await run('status','--profile',profile+'-other')).toMatchObject({code:1,stderr:''})
  await new Promise<void>(resolve=>child.once('exit',()=>resolve()))
},30000)
it('refuses an occupied URL without launching a child',async()=>{
  expect(await start(await answering(READY,true))).toMatchObject({code:1,stderr:expect.stringContaining('An existing orchestrator answers at this URL')})
  expect(existsSync(join(root,'launched'))).toBe(false)
},30000)
it('leaves a started process intact on startup timeout',async()=>{
  expect(await start('http://127.0.0.1:9','--timeout','0.3')).toMatchObject({code:1,stderr:expect.stringContaining('Startup health check timed out')})
  expect(alive(record().pid)).toBe(true)
},30000)
it('never signals a reused PID or an unmanaged process',async()=>{
  const pid=await external('--profile',profile+'-other'); mkdirSync(control(),{recursive:true})
  writeFileSync(join(control(),'service.pid'),`${pid}\n`)
  writeFileSync(join(control(),'service.json'),JSON.stringify({pid,creation:'old identity',token:'wrong',pipe:'wrong'}))
  expect(await run('stop')).toMatchObject({code:0,stdout:expect.stringContaining('Automatic recovery is paused')}); expect(alive(pid)).toBe(true)
  const unmanaged=await external('--profile',profile)
  expect(await run('stop')).toMatchObject({code:1,stderr:expect.stringContaining('authenticated graceful control')})
  expect(alive(unmanaged)).toBe(true)
},30000)
it('keeps a timed-out manual stop but leaves automatic recovery enabled after restart timeout',async()=>{
  process.env.FIXTURE_HANG='1'
  try { expect(await start(await answering())).toMatchObject({code:0}) } finally { delete process.env.FIXTURE_HANG }
  const pid=record().pid
  expect(await run('restart','--stop-timeout','0.3')).toMatchObject({code:1,stderr:expect.stringContaining('Graceful stop timed out')})
  expect(existsSync(join(control(),'manually-stopped'))).toBe(false); expect(alive(pid)).toBe(true)
  expect(await run('stop','--stop-timeout','0.3')).toMatchObject({code:1,stderr:expect.stringContaining('Graceful stop timed out')})
  expect(existsSync(join(control(),'manually-stopped'))).toBe(true); expect(alive(pid)).toBe(true)
},30000)

it('fails closed for stale locks rather than racing another recovery operation',async()=>{
  mkdirSync(control(),{recursive:true}); const lock=join(control(),'operation.lock')
  writeFileSync(lock,JSON.stringify({pid:2147483647}))
  expect(await run('status')).toMatchObject({code:1,stderr:expect.stringContaining('Another dsh-superagent control operation')})
  expect(existsSync(lock)).toBe(true)
},30000)
it('validates creation identity before contacting a managed service',async()=>{
  expect(await start(await answering())).toMatchObject({code:0}); const saved=record()
  writeFileSync(join(control(),'service.json'),JSON.stringify({...saved,creation:'reused'}))
  expect(await run('stop')).toMatchObject({code:1,stderr:expect.stringContaining('authenticated graceful control')})
  expect(alive(saved.pid)).toBe(true)
},30000)
it('routes the Python compatibility entry to the native CLI on Windows',async()=>{
  copyFileSync(join(import.meta.dirname,'..','scripts','dsh-superagent'),join(root,'scripts','dsh-superagent'))
  const result=await new Promise<{code:number;stdout:string;stderr:string}>(resolve=>execFile('python',[join(root,'scripts','dsh-superagent'),'stop','--profile',profile],{timeout:15000},(error,stdout,stderr)=>resolve({code:typeof error?.code==='number'?error.code:error?1:0,stdout,stderr})))
  expect(result).toMatchObject({code:0,stdout:expect.stringContaining('Automatic recovery is paused')})
},30000)
it('does not mistake an unrelated package bin.js for DSH',async()=>{
  copyFileSync(join(root,'bin','dsh.mjs'),join(root,'bin','bin.mjs'))
  const child=spawn(process.execPath,[join(root,'bin','bin.mjs'),'--profile',profile],{stdio:'ignore',windowsHide:true}); children.push(child); await sleep(250)
  expect(JSON.parse((await run('status')).stdout).pids).toEqual([])
},30000)
it('protects control tokens with a private native Windows DACL',async()=>{
  expect(await start(await answering())).toMatchObject({code:0})
  const output=await new Promise<string>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `$ErrorActionPreference="Stop"; $env:PSModulePath=Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/Modules"; $acl=Get-Acl -LiteralPath '${control().replace(/'/g,"''")}'; [pscustomobject]@{rules=@($acl.Access).Count; inherited=@($acl.Access | Where-Object IsInherited).Count; protected=$acl.AreAccessRulesProtected} | ConvertTo-Json -Compress`],
    {windowsHide:true,env:{...process.env,PSModulePath:join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','Modules'),DSH_TEST_FILE:control()}},
    (error,stdout)=>error?reject(error):resolve(stdout)))
  expect(JSON.parse(output)).toEqual({rules:1,inherited:0,protected:true})
},30000)

it('validates the native executable identity before requesting shutdown',async()=>{
  expect(await start(await answering())).toMatchObject({code:0}); const saved=record()
  writeFileSync(join(control(),'service.json'),JSON.stringify({...saved,executable:'C:/unrelated/node.exe'}))
  expect(await run('stop')).toMatchObject({code:1,stderr:expect.stringContaining('authenticated graceful control')})
  expect(alive(saved.pid)).toBe(true)
},30000)
it('treats Windows profile case aliases as the same service',async()=>{
  const pid=await external('--profile',profile.toUpperCase())
  expect(JSON.parse((await run('status')).stdout).pids).toEqual([pid])
},30000)
it('rejects Windows profile path aliases before creating control state',async()=>{
  for(const alias of [profile+'.','CON','nul.txt']) {
    expect(await run('stop','--profile',alias)).toMatchObject({code:1,stderr:expect.stringContaining('--profile must be a DSH profile name')})
    expect(existsSync(join(root,'.artifacts','control','profiles',alias))).toBe(false)
  }
},30000)
