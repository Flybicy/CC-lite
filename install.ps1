#requires -Version 5.1
<#
.SYNOPSIS
  Claudium installer for Windows (PowerShell).
.DESCRIPTION
  Checks for Bun and ripgrep, installs them if needed (via winget/choco/scoop/npm),
  clones the repository, builds a claudium-cli-dev.exe, and installs it as
  claudium.exe under a directory on PATH.
.NOTES
  Usage (run from an elevated or normal PowerShell 5.1+ / PowerShell 7+ window):
    irm https://raw.githubusercontent.com/Flybicy/claudium/main/install.ps1 | iex
  Or save and run:
    ./install.ps1 [-InstallDir <path>] [-Repo <url>] [-SkipBuild]
#>
[CmdletBinding()]
param(
  [string]$Repo      = "https://github.com/Flybicy/claudium.git",
  [string]$InstallDir,
  [string]$BuildDir,
  [switch]$SkipBuild,
  [string]$BunMinVersion = "1.3.11"
)

$ErrorActionPreference = "Stop"
$ProgressPreference     = "SilentlyContinue"  # speed up Invoke-WebRequest

# --- install dir ---
if (-not $InstallDir) { $InstallDir = Join-Path $env:USERPROFILE ".local\bin" }
if (-not $BuildDir)   { $BuildDir   = Join-Path $env:LOCALAPPDATA "claudium-build" }

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
  Write-Host "_________   .__                         .___ .__" -ForegroundColor DarkYellow
  Write-Host "\_   ___ \  |  |   _____     __ __    __| _/ |__|  __ __    _____"
  Write-Host "/    \  \/  |  |   \__  \   |  |  \  / __ |  |  | |  |  \  /     \"
  Write-Host "\     \____ |  |__  / __ \_ |  |  / / /_/ |  |  | |  |  / |  Y Y  \"
  Write-Host " \______  / |____/ (____  / |____/  \____ |  |__| |____/  |__|_|  /"
  Write-Host "        \/              \/               \/                     \/" -ForegroundColor DarkYellow
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
  Write-Warn "ripgrep (rg) not found. Claudium does NOT bundle it. Installing..."
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
  if (Test-Path $BuildDir) {
    Write-Warn "$BuildDir already exists"
    if (Test-Path (Join-Path $BuildDir ".git")) {
      Write-Info "Pulling latest changes..."
      git -C $BuildDir pull --ff-only origin main 2>$null
    }
  } else {
    Write-Info "Cloning repository to $BuildDir..."
    git clone --depth 1 $Repo $BuildDir
    if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed." }
  }
  Write-Ok "Source cache: $BuildDir"
}

function Install-Deps {
  Write-Info "Installing dependencies..."
  Push-Location $BuildDir
  try {
    bun install --frozen-lockfile 2>$null
    if ($LASTEXITCODE -ne 0) { bun install }
    Write-Ok "Dependencies installed"
  } finally { Pop-Location }
}

function Build-Binary {
  Write-Info "Building claudium..."
  Push-Location $BuildDir
  try {
    bun run build:dev:full
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "build:dev:full failed, trying build:dev:claudium..."
      bun run build:dev:claudium
    }
    # locate the built binary (.exe on Windows)
    $bin = Join-Path $BuildDir "claudium-cli-dev.exe"
    if (-not (Test-Path $bin)) { $bin = Join-Path $BuildDir "claudium-cli-dev" }
    if (-not (Test-Path $bin)) { Write-Fail "Build did not produce claudium-cli-dev(.exe)." }
    Write-Ok "Binary built: $bin"
    return $bin
  } finally { Pop-Location }
}

function Install-Binary([string]$Binary) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir "claudium.exe"
  Copy-Item -Path $Binary -Destination $dest -Force
  Write-Ok "Installed: $dest"

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
    $bin = Build-Binary
    Install-Binary $bin
  }
  Write-Host ""
  Write-Host "  Installation complete!" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Run it:" -ForegroundColor White
  Write-Host "    claudium                       # interactive REPL"
  Write-Host "    claudium -p `"your prompt`"            # one-shot mode"
  Write-Host ""
  Write-Host "  Set your Anthropic Messages API key:" -ForegroundColor White
  Write-Host "    `$env:ANTHROPIC_API_KEY = `"sk-ant-...`""
  Write-Host ""
  Write-Host "  Or OpenAI-compatible APIs:" -ForegroundColor White
  Write-Host "    `$env:CLAUDE_CODE_USE_OPENAI = 1"
  Write-Host "    `$env:OPENAI_BASE_URL = 'http://.../v1'"
  Write-Host ""
  Write-Host "  See README.md for full configs." -ForegroundColor White
  Write-Host ""
}

Main
