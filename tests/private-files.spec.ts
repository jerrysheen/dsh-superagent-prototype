import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { privatePath } from '../src/infra/private-files.ts'

it.skipIf(process.platform !== 'win32')('protects an already-owned directory without requiring WRITE_OWNER', () => {
  const path = mkdtempSync(join(tmpdir(), 'dsh-owner-dacl-'))
  const env = { ...process.env, DSH_TEST_PRIVATE_DIRECTORY: path }
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell/v1.0/powershell.exe')
  const run = (script: string) => execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env })
  try {
    run(`$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $p=$env:DSH_TEST_PRIVATE_DIRECTORY
      $acl=[IO.Directory]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$false)
      foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
      $rights=[Security.AccessControl.FileSystemRights]::FullControl -band (-bnot [int][Security.AccessControl.FileSystemRights]::TakeOwnership)
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,[Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)`)
    expect(() => privatePath(path, true)).not.toThrow()
    const rights = run(`$acl=[IO.Directory]::GetAccessControl($env:DSH_TEST_PRIVATE_DIRECTORY); $acl.Access[0].FileSystemRights.ToString()`)
    expect(rights.trim()).toBe('FullControl')
  } finally { rmSync(path, { recursive: true, force: true }) }
})
