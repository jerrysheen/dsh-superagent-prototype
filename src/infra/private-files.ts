/** Native private-state permissions: POSIX modes or an owner-only Windows DACL, including inherited SQLite sidecars. */
import { chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

function windowsBinary(name: string): string { return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name) }
const PROTECT = String.raw`$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$path=$env:DSH_PRIVATE_STATE_PATH
if($env:DSH_PRIVATE_STATE_DIRECTORY -eq '1') {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $flags=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
} else {
  $acl=[Security.AccessControl.FileSecurity]::new()
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
}
# Updating an unchanged owner requires WRITE_OWNER on Windows even when the
# current owner can already replace the DACL. Existing project state commonly
# grants Modify through inheritance; request only the changes we actually need.
$owner=if($env:DSH_PRIVATE_STATE_DIRECTORY -eq '1'){[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier])}else{[IO.File]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier])}
if($owner -ne $sid){$acl.SetOwner($sid)}
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule($rule)
if($env:DSH_PRIVATE_STATE_DIRECTORY -eq '1'){[IO.Directory]::SetAccessControl($path,$acl)}else{[IO.File]::SetAccessControl($path,$acl)}`
/** Apply the current account's full access with no other ACEs; directories propagate it to WAL/SHM files. */
export function privatePath(path: string, directory: boolean): void {
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); return }
  // Replace the complete DACL in one native operation; never temporarily restore broad parent inheritance.
  execFileSync(windowsBinary('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(PROTECT, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_PRIVATE_STATE_PATH: path, DSH_PRIVATE_STATE_DIRECTORY: directory ? '1' : '0' } })
}
