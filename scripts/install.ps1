# Pharo Agent installer for Windows (PowerShell 5+):
#   irm https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/scripts/install.ps1 | iex
# Installs to %LOCALAPPDATA%\pharo-agent, puts pharo-agent on your PATH, then runs setup.
$ErrorActionPreference = 'Stop'

$repoUrl = if ($env:PHARO_AGENT_REPO_URL) { $env:PHARO_AGENT_REPO_URL } else { 'https://github.com/pharo-llm/pharo-agent/archive/refs/heads/main.zip' }
$root = if ($env:PHARO_AGENT_HOME) { $env:PHARO_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'pharo-agent' }
$appDir = Join-Path $root 'app'
$binDir = if ($env:PHARO_AGENT_BIN_DIR) { $env:PHARO_AGENT_BIN_DIR } else { Join-Path $root 'bin' }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'pharo-agent: Node.js 22.6.0 or newer is required (https://nodejs.org).' }
$nodeVersion = [version](& $node.Source -p 'process.versions.node')
if ($nodeVersion -lt [version]'22.6.0') { throw "pharo-agent: Node.js 22.6.0 or newer is required (found $nodeVersion)." }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pharo-agent-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'pharo-agent.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $repoUrl -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp
  $source = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
  New-Item -ItemType Directory -Force -Path $appDir, $binDir | Out-Null
  Copy-Item -Path (Join-Path $source.FullName '*') -Destination $appDir -Recurse -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$launcher = Join-Path $binDir 'pharo-agent.cmd'
$cli = Join-Path $appDir 'pharo-agent\cli.ts'
Set-Content -Path $launcher -Encoding ASCII -Value "@echo off`r`n`"$($node.Source)`" `"$cli`" %*"
Write-Host "pharo-agent installed to $launcher"

# Put the bin directory on the user PATH, so nothing has to be set by hand.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  if (-not $env:PHARO_AGENT_NO_MODIFY_PATH) {
    [Environment]::SetEnvironmentVariable('Path', ($binDir + ';' + $userPath).TrimEnd(';'), 'User')
    Write-Host "Added $binDir to your PATH (new terminals will have it)."
  } else {
    Write-Host "Add $binDir to PATH to run pharo-agent from any terminal."
  }
}
$env:Path = "$binDir;$env:Path"

if (-not $env:PHARO_AGENT_NO_SETUP -and -not $env:CI) {
  Write-Host ''
  & $launcher setup
  Write-Host 'Run pharo-agent to start.'
} else {
  Write-Host 'Run: pharo-agent    (first run asks a few setup questions)'
}
