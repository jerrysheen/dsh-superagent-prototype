#!/usr/bin/env node
/** Windows-native DSH service control. POSIX users retain scripts/dsh-superagent.
 * Never use process.kill(SIGINT) on Windows: Node implements it as termination.
 * The preload bridge invokes DSH's own SIGINT handlers inside the target process.
 */
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, '.artifacts')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const live = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
function command(program, args) {
  return new Promise((resolve, reject) => execFile(program, args, {
    windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')},
  }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}
/** Apply a user-only DACL atomically; never restore broad inheritance with /reset. */
async function protect(directories) {
  const ps=join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
  const paths=directories.map(path=>"'"+path.replace(/'/g,"''")+"'").join(',')
  await command(ps,['-NoProfile','-NonInteractive','-Command',
    `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($path in @(${paths})) { $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($path,$acl) }`])
}
/** Parse Windows argv quoting, including escaped quotes and terminal backslashes. */
export function windowsArgv(line) {
  const words = []; let word = '', quoted = false, started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      let count = 1; while (line[i + 1] === '\\') { count++; i++ }
      if (line[i + 1] === '"') { word += '\\'.repeat(Math.floor(count / 2)); i++; if (count % 2) word += '"'; else quoted = !quoted }
      else word += '\\'.repeat(count)
      started = true
    } else if (c === '"') { quoted = !quoted; started = true }
    else if (/\s/.test(c) && !quoted) { if (started) { words.push(word); word = ''; started = false } }
    else { word += c; started = true }
  }
  if (started) words.push(word)
  return words
}
function serves(row, profile, expectedEntry) {
  if (!/^(node|dsh)(\.exe)?$/i.test(row.name)) return false
  const args = windowsArgv(row.command || '')
  // Only a DSH entry point counts: arbitrary node programs accepting --profile do not.
  const samePath=(left,right)=>resolve(left).toLowerCase()===resolve(right).toLowerCase()
  const entry = args.find((arg, index) => index > 0 && !arg.startsWith('-') && (
    (expectedEntry && samePath(arg,expectedEntry)) || /(?:^|[\\/])dsh(?:\.[cm]?js)?$/i.test(arg)
    || /[\\/](?:dsh[\\/]lib|apps[\\/]cli[\\/]lib)[\\/]bin\.[cm]?js$/i.test(arg)))
  if (!entry && !/^dsh(?:\.exe)?$/i.test(row.name)) return false
  const words = args.slice(args.indexOf(entry) + 1)
  let matched = false
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--profile') { if (words[++i]?.toLowerCase() === profile.toLowerCase()) matched = true }
    else if (words[i].startsWith('--profile=') && words[i].slice('--profile='.length).toLowerCase() === profile.toLowerCase()) matched = true
    else if (words[i] === 'plugin') return false
  }
  return matched
}
async function scan(profile, entry) {
  if (process.platform !== 'win32') throw new Error('Use scripts/dsh-superagent for POSIX service control.')
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await command(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'; @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='dsh.exe'" | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;executable=$_.ExecutablePath;command=$_.CommandLine;creation=$_.CreationDate.ToUniversalTime().Ticks.ToString()} }) | ConvertTo-Json -Compress`])
  const parsed=JSON.parse(result || '[]')
  const recorded=json(join(ARTIFACTS,'control','profiles',profile,'service.json'))
  return (Array.isArray(parsed)?parsed:[parsed]).filter(row => serves(row, profile, entry || recorded?.entry))
}
async function state(url) {
  try {
    const response = await fetch(url.replace(/\/$/, '') + '/orchestrator/api/state', {headers:{'x-orchestrator-request':'1'},signal:AbortSignal.timeout(2000)})
    if (!response.ok) return null
    const value = await response.json(); const health = {}, errors = {}
    for (const [name, entry] of Object.entries(value.health || {})) { health[name] = entry?.state; if(entry?.state === 'error') errors[name] = String(entry.detail || '') }
    return {health, errors, setup:value.setup?.problem || null, feishu:value.setup?.feishuProblem || null}
  } catch { return null }
}
const runtimeUp = current => current && ['ready','paused'].includes(current.health.runtime)
const partErrors = current => Object.entries(current?.errors || {}).filter(([name]) => name !== 'runtime')
const outcome = (rows,current) => rows.length !== 1 || !runtimeUp(current) ? 1 : current.setup ? 3 : partErrors(current).length ? 2 : 0
async function status(args, rows) {
  rows ??= await scan(args.profile,args.entry); const current = rows.length ? await state(args.url) : null
  console.log(JSON.stringify({pids:rows.map(row=>row.pid),cwd:ROOT,url:args.url,manually_stopped:existsSync(args.marker),health:current?.health || null,errors:current?.errors || null,setup:current?.setup || null,feishu:current?.feishu || null},null,2))
  return outcome(rows,current)
}
async function graceful(record) {
  await new Promise((resolve,reject) => {
    const socket = createConnection(record.pipe); let response = ''
    socket.setTimeout(2000,()=>socket.destroy(new Error('Graceful control channel timed out')))
    socket.on('error',reject)
    socket.on('connect',()=>socket.write(JSON.stringify({token:record.token,pid:record.pid})+'\n'))
    socket.on('data',chunk=>{response+=chunk; if(response.includes('\n')) {socket.end(); response.trim()==='ok' ? resolve() : reject(new Error('Graceful control refused'))}})
  })
}
async function stop(args, intentional) {
  const rows=await scan(args.profile,args.entry)
  if(rows.length>1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  if(intentional) writeFileSync(args.marker,new Date().toISOString()+'\n')
  if(rows.length) {
    const record=json(join(args.control,'service.json')); const row=rows[0]
    if(!record || record.pid!==row.pid || record.creation!==row.creation || record.executable!==row.executable || !record.pipe || !record.token)
      throw new Error('Service has no authenticated graceful control; refusing to terminate an unmanaged or reused PID.')
    await graceful(record)
    const deadline=Date.now()+args.stopTimeout*1000
    while(live(row.pid)) { if(Date.now()>=deadline) throw new Error('Graceful stop timed out; no forced kill was sent. Check status.'); await delay(100) }
  }
  rmSync(join(args.control,'service.pid'),{force:true}); rmSync(join(args.control,'service.json'),{force:true})
  console.log(intentional?'dsh-superagent stopped. Automatic recovery is paused until start/restart.':'dsh-superagent stopped.')
}
function dshEntry(args) {
  if(args.entry) return resolve(args.entry)
  try { return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js') }
  catch { throw new Error('Install @deepseek-ai/dsh or provide --dsh-entry pointing to its native JavaScript CLI entry.') }
}
function prune(profile) {
  const pattern = new RegExp('^dsh-superagent-'+profile.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'-\\d{8}-\\d{6}-\\d+\\.log$','i')
  const logs=readdirSync(ARTIFACTS).filter(name=>pattern.test(name)).map(name=>join(ARTIFACTS,name)).sort((a,b)=>statSync(a).mtimeMs-statSync(b).mtimeMs)
  for(const log of logs.slice(0,-20)) rmSync(log)
}
async function start(args) {
  let rows=await scan(args.profile,args.entry)
  if(rows.length>1) throw new Error('Multiple dsh-superagent processes found; refusing to start another.')
  if(!rows.length) {
    if(await state(args.url)) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
    const entry=dshEntry(args)
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)
    const log=join(ARTIFACTS,`dsh-superagent-${args.profile}-${stamp}-${process.pid}.log`)
    const fd=openSync(log,'a',0o600); prune(args.profile)
    const token=randomBytes(32).toString('hex'), pipe='\\\\.\\pipe\\dsh-superagent-'+randomBytes(24).toString('hex')
    let child
    try {
      child=spawn(process.execPath,['--import',pathToFileURL(join(ROOT,'scripts','service-bridge.mjs')).href,entry,'--profile',args.profile,'--no-open'],{
        cwd:ROOT,detached:true,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,DSH_SERVICE_PIPE:pipe,DSH_SERVICE_TOKEN:token},
      })
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
    } finally { closeSync(fd) }
    child.unref()
    rows=await scan(args.profile,entry)
    const row=rows.find(row=>row.pid===child.pid)
    if(!row) throw new Error('Started service exited before its process identity could be recorded. Inspect '+log)
    if(!row.executable || resolve(row.executable).toLowerCase()!==resolve(process.execPath).toLowerCase()) throw new Error('Started service executable identity differs from the requested Node executable.')
    writeFileSync(join(args.control,'service.json'),JSON.stringify({pid:row.pid,creation:row.creation,executable:row.executable,token,pipe,log,entry}),{mode:0o600})
    writeFileSync(join(args.control,'service.pid'),row.pid+'\n')
    console.log('Log: '+log)
  } else console.log(`dsh-superagent already running (PID ${rows[0].pid}); no duplicate started.`)
  rmSync(args.marker,{force:true})
  const deadline=Date.now()+args.timeout*1000
  while(Date.now()<deadline) {
    const current=await state(args.url)
    if(rows.length===1 && live(rows[0].pid) && runtimeUp(current)) {
      const code=await status(args)
      if(current.setup) console.log('dsh-superagent is waiting for setup: '+String(current.setup.detail || ''))
      if(current.feishu) console.log('dsh-superagent runs without Feishu: '+String(current.feishu.detail || ''))
      for(const [name,detail] of partErrors(current)) console.log(`${name} reports an error, which a restart does not fix: ${detail}`)
      return code
    }
    await delay(100)
  }
  await status(args, rows.filter(row=>live(row.pid)))
  throw new Error('Startup health check timed out; inspect the log. Any running process was left intact.')
}
async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{profile:{type:'string',default:process.env.DSH_SUPERAGENT_PROFILE || 'superagent'},url:{type:'string',default:process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082'},timeout:{type:'string',default:'60'},'stop-timeout':{type:'string',default:'300'},'respect-stop':{type:'boolean'},'dsh-entry':{type:'string'}}})
  const args={...values,action:positionals[0],timeout:Number(values.timeout),stopTimeout:Number(values['stop-timeout']),entry:values['dsh-entry']}
  if(positionals.length!==1 || !['start','stop','restart','status'].includes(args.action)) throw new Error('Usage: node scripts/dsh-superagent.mjs start|stop|restart|status [--profile NAME] [--dsh-entry FILE]')
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(args.profile) || args.profile.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(args.profile)) throw new Error('--profile must be a DSH profile name without Windows reserved names or path aliases')
  if(!Number.isFinite(args.timeout)||!Number.isFinite(args.stopTimeout)||args.timeout<=0||args.stopTimeout<=0) throw new Error('--timeout and --stop-timeout must be positive')
  args.control=join(ARTIFACTS,'control','profiles',args.profile); mkdirSync(args.control,{recursive:true}); args.marker=join(args.control,'manually-stopped')
  await protect([ARTIFACTS,args.control])
  const lock=join(args.control,'operation.lock'); let fd
  try { fd=openSync(lock,'wx',0o600) } catch(error) {
    if(error.code!=='EEXIST') throw error
    // Never unlink an apparent stale lock automatically: another controller could
    // acquire it between inspection and removal. Operator verifies ownership first.
    throw new Error('Another dsh-superagent control operation is in progress. If the controller exited, verify it is stopped before removing operation.lock.')
  }
  writeFileSync(fd,JSON.stringify({pid:process.pid})); closeSync(fd)
  try {
    if(values['respect-stop'] && ['start','restart'].includes(args.action) && existsSync(args.marker)) {console.log('Intentional stop is active; automatic recovery skipped.');return 0}
    if(args.action==='status') return await status(args)
    if(['stop','restart'].includes(args.action)) await stop(args,args.action==='stop')
    if(['start','restart'].includes(args.action)) return await start(args)
    return 0
  } finally {rmSync(lock,{force:true})}
}
main().then(code=>{process.exitCode=code}).catch(error=>{console.error(error.message);process.exitCode=1})
