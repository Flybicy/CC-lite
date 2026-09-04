#requires -Version 5.1
<#
.SYNOPSIS
  CC-lite installer for Windows (PowerShell).
.DESCRIPTION
  Checks for Bun and ripgrep, installs them if needed (via winget/choco/scoop/npm),
  clones the repository, builds a JS bundle, installs it plus the local
  semantic embedding runtime, and creates cclite.cmd shims on PATH.
.NOTES
  Usage (run from an elevated or normal PowerShell 5.1+ / PowerShell 7+ window):
    irm https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.ps1 | iex
  Or save and run:
    ./install.ps1 [-InstallDir <path>] [-Repo <url>] [-SkipBuild]
#>
[CmdletBinding()]
param(
  [string]$Repo      = "https://github.com/Flybicy/CC-lite.git",
  [string]$InstallDir,
  [string]$BuildDir,
  [string]$LibDir,
  [switch]$SkipBuild,
  [string]$BunMinVersion = "1.3.11"
)

$ErrorActionPreference = "Stop"
$ProgressPreference     = "SilentlyContinue"  # speed up Invoke-WebRequest

# --- install dir ---
if (-not $InstallDir) { $InstallDir = Join-Path $env:USERPROFILE ".local\bin" }
if (-not $BuildDir)   { $BuildDir   = Join-Path $env:LOCALAPPDATA "cclite-build" }
# Runtime home: the JS bundle plus the node_modules carrying the local
# semantic embedding stack (Transformers.js + ONNX Runtime). A single
# compiled .exe cannot be used - `bun build --compile` puts onnxruntime's
# native .node file in a virtual filesystem that cannot be dlopen'd, which
# silently degrades semantic search to the approximate fallback.
if (-not $LibDir)     { $LibDir     = Join-Path $env:USERPROFILE ".local\lib\cclite" }
# Pinned: must match the repo's package.json/bun.lock.
$TransformersVersion = "3.8.1"

# --- helpers ---
function Write-Info  { param([string]$m) Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn  { param([string]$m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Fail  { param([string]$m) Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

function Test-Command { param([string]$c)
  return [bool](Get-Command $c -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
  # Installers (winget/scoop/choco) update the registry PATH but not the
  # current session; re-read Machine+User PATH so freshly installed tools
  # become visible immediately.
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
              [Environment]::GetEnvironmentVariable('PATH','User')
}

function Get-BunVersion {
  if (Test-Command bun) {
    try { return (bun --version) } catch { return "0.0.0" }
  }
  return $null
}

function Compare-VersionGe([string]$a, [string]$b) {
  # returns $true if $a >= $b
  $ap = $a.Split('.')   | ForEach-Object { [int]$_ }
  $bp = $b.Split('.')   | ForEach-Object { [int]$_ }
  $max = [Math]::Max($ap.Count, $bp.Count)
  while ($ap.Count -lt $max) { $ap += 0 }
  while ($bp.Count -lt $max) { $bp += 0 }
  for ($i = 0; $i -lt $max; $i++) {
    if ($ap[$i] -gt $bp[$i]) { return $true }
    if ($ap[$i] -lt $bp[$i]) { return $false }
  }
  return $true  # equal
}

# --- header ---
function Show-Header {
  Write-Host ""
  Write-Host "CC-lite installer" -ForegroundColor Cyan
  Write-Host ""
}

# --- system checks ---
function Check-Prerequisites {
  Write-Info "Checking system..."
  if ($PSVersionTable.PSVersion.Major -lt 5) { Write-Fail "PowerShell 5.1+ required." }
  Write-Ok "PowerShell $($PSVersionTable.PSVersion)"
}

function Ensure-Git {
  if (Test-Command git) {
    Write-Ok "git: $(git --version | Select-Object -First 1)"
    return
  }
  Write-Info "git not found. Installing..."
  if (Test-Command winget) {
    Write-Info "Trying winget install Git.Git..."
    winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements 2>$null
  }
  Update-SessionPath
  if (-not (Test-Command git) -and (Test-Command scoop)) {
    Write-Info "Trying scoop install git..."
    scoop install git 2>$null
    Update-SessionPath
  }
  if (-not (Test-Command git) -and (Test-Command choco)) {
    Write-Info "Trying choco install git..."
    choco install git -y 2>$null
    Update-SessionPath
  }
  if (Test-Command git) {
    Write-Ok "git: $(git --version | Select-Object -First 1) (installed)"
    return
  }
  Write-Warn "Automatic git install failed. Install manually:"
  Write-Host "  winget install Git.Git"
  Write-Host "  OR download: https://git-scm.com/download/win"
  Write-Fail "git is required but not on PATH."
}

function Ensure-Bun {
  $ver = Get-BunVersion
  if ($ver -and (Compare-VersionGe $ver $BunMinVersion)) {
    Write-Ok "bun: v$ver"
    return
  }
  if ($ver) { Write-Warn "bun v$ver found but v$BunMinVersion+ required. Upgrading..." }
  else      { Write-Info "bun not found. Installing..." }

  # Prefer winget (Win10+ ships with it, Bundler/MSIX), then scoop, then choco, then npm.
  if (Test-Command winget) {
    Write-Info "Trying winget install Oven-sh.Bun..."
    winget install --id Oven-sh.Bun --silent --accept-package-agreements --accept-source-agreements 2>$null
  }
  elseif (Test-Command scoop) {
    Write-Info "Trying scoop install bun..."
    scoop install bun 2>$null
  }
  elseif (Test-Command choco) {
    Write-Info "Trying choco install bun..."
    choco install bun -y 2>$null
  }

  # Re-check after package manager installs
  Update-SessionPath
  $ver = Get-BunVersion
  if ($ver -and (Compare-VersionGe $ver $BunMinVersion)) {
    Write-Ok "bun: v$ver (installed)"
    return
  }

  # Fallback: npm install -g bun (works if Node/npm present)
  if (Test-Command npm) {
    Write-Info "Trying npm install -g bun..."
    npm install -g bun 2>$null
    $ver = Get-BunVersion
    if ($ver -and (Compare-VersionGe $ver $BunMinVersion)) {
      Write-Ok "bun: v$ver (via npm)"
      return
    }
  }

  if (-not $ver) {
    Write-Warn "Automatic Bun install failed. Install manually:"
    Write-Host "  winget install Oven-sh.Bun"
    Write-Host "  scoop install bun"
    Write-Host "  choco install bun"
    Write-Host "  OR: powershell -c `"irm bun.sh/install.ps1|iex`""
  }
  Write-Fail "bun >= $BunMinVersion not found after install attempt."
}

function Ensure-Ripgrep {
  if (Test-Command rg) {
    Write-Ok "rg: $(rg --version | Select-Object -First 1)"
    return
  }
  Write-Warn "ripgrep (rg) not found. CC-lite does NOT bundle it. Installing..."
  if (Test-Command winget) {
    winget install --id BurntSushi.ripgrep.MSVC --silent --accept-package-agreements --accept-source-agreements 2>$null
  }
  if (-not (Test-Command rg) -and (Test-Command scoop)) {
    scoop install ripgrep 2>$null
  }
  if (-not (Test-Command rg) -and (Test-Command choco)) {
    choco install ripgrep -y 2>$null
  }
  Update-SessionPath
  if (Test-Command rg) { Write-Ok "rg installed" }
  else {
    Write-Warn "Automatic ripgrep install failed. Install manually:"
    Write-Host "  scoop install ripgrep"
    Write-Host "  winget install BurntSushi.ripgrep.MSVC"
    Write-Host "  choco install ripgrep"
    Write-Fail "ripgrep is required but not on PATH."
  }
}

# --- clone & build ---
function Clone-Repo {
  function New-SourceClone {
    if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
    Write-Info "Cloning repository to $BuildDir..."
    git clone --depth 1 $Repo $BuildDir
    if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed." }
  }

  if (Test-Path $BuildDir) {
    Write-Warn "$BuildDir already exists"
    if (Test-Path (Join-Path $BuildDir ".git")) {
      # The old "pull --ff-only … 2>$null" silently swallowed failures and
      # left a stale source tree as a "successful" install. Fetch the exact
      # remote tip and force the local tree to match it instead.
      Write-Info "Updating source to remote main..."
      git -C $BuildDir fetch origin main --depth 1 2>&1 | Out-Null
      git -C $BuildDir reset --hard FETCH_HEAD 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Warn "git update failed; removing and re-cloning $BuildDir"
        New-SourceClone
      }
    } else {
      Write-Warn "Cached directory is not a git checkout; removing and re-cloning"
      New-SourceClone
    }
  } else {
    New-SourceClone
  }

  if (-not (Test-Path (Join-Path $BuildDir "package.json"))) {
    Write-Fail "Source cache is incomplete: $BuildDir has no package.json. Remove it and retry."
  }
  Write-Ok "Source cache: $BuildDir"
}

function Install-Deps {
  Write-Info "Installing dependencies..."
  Push-Location $BuildDir
  try {
    bun install --frozen-lockfile 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Frozen dependency install failed; falling back to bun install"
      bun install
      if ($LASTEXITCODE -ne 0) { Write-Fail "bun install failed in $BuildDir." }
    }
    Write-Ok "Dependencies installed"
  } finally { Pop-Location }
}

function Build-Bundle {
  Write-Info "Building cclite (JS bundle)..."
  Push-Location $BuildDir
  try {
    bun run build:bundle:cclite
    if ($LASTEXITCODE -ne 0) { Write-Fail "bun run build:bundle:cclite failed in $BuildDir." }
    $bundle = Join-Path $BuildDir "cclite.js"
    if (-not (Test-Path $bundle)) { Write-Fail "Build did not produce cclite.js." }
    # Standalone verifier shipped next to the bundle so the model can be
    # re-checked later via cclite-verify-embeddings.cmd.
    bun run build:bundle:verify
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Could not build the embeddings verifier (non-fatal)"
    }
    Write-Ok "Bundle built: $bundle"
    return $bundle
  } finally { Pop-Location }
}

# Install the runtime home: the JS bundle plus a minimal node_modules that
# carries the local semantic embedding stack.
function Install-Lib {
  Write-Info "Installing runtime to $LibDir..."
  New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
  Copy-Item -Path (Join-Path $BuildDir "cclite.js") -Destination (Join-Path $LibDir "cclite.js") -Force
  $verifySrc = Join-Path $BuildDir "verify-embeddings.js"
  if (Test-Path $verifySrc) {
    Copy-Item -Path $verifySrc -Destination (Join-Path $LibDir "verify-embeddings.js") -Force
  }

  # Minimal manifest: only the embedding stack resolves at runtime; every
  # other dependency is already inlined in the bundle.
  $manifest = @"
{
  "name": "cclite-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@huggingface/transformers": "$TransformersVersion"
  }
}
"@
  Set-Content -Path (Join-Path $LibDir "package.json") -Value $manifest -Encoding UTF8

  Write-Info "Installing the local semantic embedding model runtime (~130MB)..."
  Push-Location $LibDir
  try {
    bun install --trust 2>$null
    if ($LASTEXITCODE -ne 0) { bun install }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Could not install the embedding runtime."
      Write-Warn "Semantic search will fall back to approximate matching."
      return
    }
  } finally { Pop-Location }

  Trim-Lib
  Write-Ok "Runtime installed: $LibDir"
}

# Drop what the embedding path never loads: sourcemaps, type stubs, the
# browser ONNX build, and the foreign-platform native binaries.
function Trim-Lib {
  $nm = Join-Path $LibDir "node_modules"
  if (-not (Test-Path $nm)) { return }
  $before = [math]::Round((Get-ChildItem $nm -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum / 1MB)
  Get-ChildItem $nm -Recurse -Filter "*.map" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $nm "@types") -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $nm "onnxruntime-web") -ErrorAction SilentlyContinue
  $napi = Join-Path $nm "onnxruntime-nodein
api-v3"
  if (Test-Path $napi) {
    Get-ChildItem $napi -Directory -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -ne "win32"
    } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  $after = [math]::Round((Get-ChildItem $nm -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum / 1MB)
  Write-Info "Trimmed runtime: ${before}MB -> ${after}MB"
}

# Download + smoke-test the embedding model so the first search is instant
# and the user sees proof that real semantic search works.
function Prefetch-Model {
  $verify = Join-Path $LibDir "verify-embeddings.js"
  if (-not (Test-Path $verify)) { return }
  Write-Info "Downloading the semantic model (~23MB, one time) and verifying..."
  Push-Location $LibDir
  try {
    bun ./verify-embeddings.js
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Semantic search ready"
    } else {
      Write-Warn "Model prefetch/verification failed - semantic search will fall"
      Write-Warn "back to approximate matching. Re-run: cclite-verify-embeddings"
    }
  } finally { Pop-Location }
}

# cclite / cclite-bypass / cclite-verify-embeddings are .cmd shims that run
# `bun` against the installed bundle. No `cd` in the main shim: cclite must
# operate on the user's current directory (Bun resolves node_modules from the
# entry script's own location).
function Install-Launchers {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $bundle = Join-Path $LibDir "cclite.js"

  $mainCmd = @"
@echo off
setlocal
bun "$bundle" %*
"@
  Set-Content -Path (Join-Path $InstallDir "cclite.cmd") -Value $mainCmd -Encoding ASCII
  Write-Ok "Installed: $(Join-Path $InstallDir 'cclite.cmd')"

  $bypassCmd = @"
@echo off
setlocal
set IS_SANDBOX=1
bun "$bundle" --permission-mode bypassPermissions %*
"@
  Set-Content -Path (Join-Path $InstallDir "cclite-bypass.cmd") -Value $bypassCmd -Encoding ASCII
  Write-Ok "Installed: $(Join-Path $InstallDir 'cclite-bypass.cmd')"

  # ccliteweb: opens the local config WebUI directly (alias of `cclite web`).
  $webCmd = @"
@echo off
setlocal
bun "$bundle" web %*
"@
  Set-Content -Path (Join-Path $InstallDir "ccliteweb.cmd") -Value $webCmd -Encoding ASCII
  Write-Ok "Installed: $(Join-Path $InstallDir 'ccliteweb.cmd')"

  $verifyJs = Join-Path $LibDir "verify-embeddings.js"
  if (Test-Path $verifyJs) {
    $verifyCmd = @"
@echo off
setlocal
bun "$verifyJs" %*
"@
    Set-Content -Path (Join-Path $InstallDir "cclite-verify-embeddings.cmd") -Value $verifyCmd -Encoding ASCII
    Write-Ok "Installed: $(Join-Path $InstallDir 'cclite-verify-embeddings.cmd')"
  }

  # path warning
  $pathParts = $env:PATH -split ';'
  if ($pathParts -notcontains $InstallDir) {
    Write-Warn "$InstallDir is not on your PATH."
    Write-Host "  Add it permanently with:" -ForegroundColor Yellow
    Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `"$InstallDir;`$([Environment]::GetEnvironmentVariable('PATH','User'))`", 'User')" -ForegroundColor White
    Write-Host "  then open a new terminal." -ForegroundColor White
    Write-Host ""
    # Also try to add it to the user PATH automatically (non-fatal)
    try {
      $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
      if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$userPath", "User")
        Write-Ok "Added $InstallDir to your user PATH (restart your terminal to use it)."
      }
    } catch { Write-Warn "Could not auto-add to PATH." }
  } else {
    Write-Ok "$InstallDir is already on PATH."
  }
}

# --- main ---
function Main {
  Show-Header
  Write-Info "Starting installation..."
  Write-Host ""
  Check-Prerequisites
  Ensure-Git
  Ensure-Bun
  Ensure-Ripgrep
  Write-Host ""
  Clone-Repo
  Install-Deps
  if (-not $SkipBuild) {
    Build-Bundle | Out-Null
    Install-Lib
    Install-Launchers
    Prefetch-Model
  }
  Write-Host ""
  Write-Host "  Installation complete!" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Run it:" -ForegroundColor White
  Write-Host "    cclite                       # interactive REPL"
  Write-Host "    cclite -p `"your prompt`"            # one-shot mode"
  Write-Host "    cclite-verify-embeddings            # re-check the local semantic model"
  Write-Host "    ccliteweb                          # WebUI at 127.0.0.1:1511 - providers + pro/plus/se models"
  Write-Host ""
  Write-Host "  Recommended: configure providers via the local WebUI:" -ForegroundColor White
  Write-Host "    ccliteweb        # save several providers, then bind the pro / plus / se models"
  Write-Host "                     # pro/plus/se = 三档代号, 失败自动顺次降级"
  Write-Host "                     # saving applies on the next request - no restart"
  Write-Host ""
  Write-Host "  Or set your Anthropic Messages API key:" -ForegroundColor White
  Write-Host "    `$env:ANTHROPIC_API_KEY = `"sk-ant-...`""
  Write-Host ""
  Write-Host "  Or OpenAI-compatible APIs (also via `cclite config`):" -ForegroundColor White
  Write-Host "    `$env:CLAUDE_CODE_USE_OPENAI = 1"
  Write-Host "    `$env:OPENAI_BASE_URL = 'http://.../v1'"
  Write-Host ""
  Write-Host "  See README.md for full configs." -ForegroundColor White
  Write-Host ""
}

Main
