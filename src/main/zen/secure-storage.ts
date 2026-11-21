import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$principals = @($env:MAI_USER_SID, 'S-1-5-18', 'S-1-5-32-544')

function Set-VerifiedAcl([string] $Path, [bool] $Directory) {
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $permission = if ($Directory) { '(OI)(CI)F' } else { 'F' }
  $arguments = @($Path, '/inheritance:r', '/grant:r')
  foreach ($principal in $principals) {
    $arguments += "*$($principal):$permission"
  }
  & $icacls @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed to apply the private storage DACL.' }

  $verified = Get-Acl -LiteralPath $Path
  $entries = @($verified.Access)
  if (-not $verified.AreAccessRulesProtected -or $entries.Count -ne 3) {
    throw 'Private storage ACL verification failed.'
  }

  $seen = @()
  foreach ($entry in $entries) {
    $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $expectedInheritance = if ($Directory) {
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [System.Security.AccessControl.InheritanceFlags]::None
    }
    if ($sid -notin $principals -or
        $entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $entry.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
        $entry.InheritanceFlags -ne $expectedInheritance) {
      throw 'Private storage ACL contains an unexpected access rule.'
    }
    $seen += $sid
  }
  foreach ($principal in $principals) {
    if ($principal -notin $seen) { throw 'Private storage ACL is missing a required principal.' }
  }
}

if ($env:MAI_APPLY_DIR -eq '1') {
  Set-VerifiedAcl -Path $env:MAI_PRIVATE_DIR -Directory $true
}
if ($env:MAI_PRIVATE_FILE -and (Test-Path -LiteralPath $env:MAI_PRIVATE_FILE)) {
  Set-VerifiedAcl -Path $env:MAI_PRIVATE_FILE -Directory $false
}
Write-Output 'ACL_OK'
`

function currentWindowsUserSid(): string {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const output = execFileSync(path.join(windowsRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const sid = output.match(/\bS-1-5-(?:\d+-)*\d+\b/)?.[0]
  if (!sid) throw new Error('Could not determine the current Windows user SID.')
  return sid
}

export function securePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true })
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Private storage path must be a real directory, not a file or reparse-point link.')
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700)
    return
  }

  const output = execFileSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAI_PRIVATE_DIR: directory,
        MAI_PRIVATE_FILE: '',
        MAI_APPLY_DIR: '1',
        MAI_USER_SID: currentWindowsUserSid(),
      },
    },
  )
  if (!output.includes('ACL_OK')) throw new Error('Windows private directory ACL was not verified.')
}

export function securePrivateFile(filePath: string, directory: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600)
    return
  }

  const output = execFileSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAI_PRIVATE_DIR: directory,
        MAI_PRIVATE_FILE: filePath,
        MAI_APPLY_DIR: '0',
        MAI_USER_SID: currentWindowsUserSid(),
      },
    },
  )
  if (!output.includes('ACL_OK')) throw new Error('Windows private file ACL was not verified.')
}
