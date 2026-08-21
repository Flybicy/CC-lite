#!/usr/bin/env bash
set -euo pipefail

# cclite installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.sh | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
ORANGE='\033[38;5;208m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="https://github.com/Flybicy/CC-lite.git"
BUILD_DIR="$HOME/.cache/cclite"
INSTALL_DIR="$HOME/.local/bin"
# Runtime home: holds the JS bundle plus the node_modules that the local
# semantic embedding model needs. A single compiled binary cannot be used
# here - `bun build --compile` puts onnxruntime's native .node file in a
# virtual filesystem that dlopen() cannot load, which silently degrades
# semantic search to the approximate fallback.
LIB_DIR="$HOME/.local/lib/cclite"
BUN_MIN_VERSION="1.3.11"
# Pinned: must match the version in the repo's package.json/bun.lock.
TRANSFORMERS_VERSION="3.8.1"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${CYAN}CC-lite${RESET} installer"
  echo ""
  echo ""
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin)              OS="macos";   BIN_EXT=""     ;;
    Linux)               OS="linux";   BIN_EXT=""     ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows"; BIN_EXT=".exe" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS, Linux, or Windows (Git Bash) required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

# Detect the system package manager (empty when none is known).
detect_pkg_mgr() {
  if   command -v apt-get &>/dev/null; then echo apt
  elif command -v dnf     &>/dev/null; then echo dnf
  elif command -v yum     &>/dev/null; then echo yum
  elif command -v pacman  &>/dev/null; then echo pacman
  elif command -v zypper  &>/dev/null; then echo zypper
  elif command -v apk     &>/dev/null; then echo apk
  elif command -v brew    &>/dev/null; then echo brew
  else echo ""
  fi
}

# Install a package with the detected package manager (best effort).
#
# This script is normally run as `curl ... | bash`, so stdin is the pipe, not a
# terminal: any command that prompts (a sudo password, an apt "are you sure")
# would hang forever with no visible reason. So: only use sudo when it is
# already passwordless, and redirect every package command's stdin from
# /dev/null so a stray prompt fails fast instead of hanging.
pkg_install() {
  local name="$1" mgr
  mgr="$(detect_pkg_mgr)"
  [ -z "$mgr" ] && return 1

  local SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
      SUDO="sudo -n"
    else
      warn "Cannot install $name automatically: root is required and sudo would"
      warn "ask for a password (this script has no terminal to type it into)."
      warn "Run this first, then re-run the installer:"
      warn "    sudo $(printf '%s' "$mgr") install $name"
      return 1
    fi
  fi

  info "Installing $name via $mgr..."
  export DEBIAN_FRONTEND=noninteractive
  case "$mgr" in
    apt)    $SUDO apt-get update -qq </dev/null && $SUDO apt-get install -y "$name" </dev/null ;;
    dnf)    $SUDO dnf install -y "$name" </dev/null ;;
    yum)    $SUDO yum install -y "$name" </dev/null ;;
    pacman) $SUDO pacman -Sy --noconfirm "$name" </dev/null ;;
    zypper) $SUDO zypper --non-interactive install "$name" </dev/null ;;
    apk)    $SUDO apk add "$name" </dev/null ;;
    brew)   brew install "$name" </dev/null ;;
    *)      return 1 ;;
  esac
}

check_git() {
  if command -v git &>/dev/null; then
    ok "git: $(git --version | head -1)"
    return
  fi
  info "git not found. Installing..."
  if [ "$OS" = "macos" ] && ! command -v brew &>/dev/null; then
    # No package manager on macOS: trigger the Xcode CLT installer.
    xcode-select --install 2>/dev/null || true
    fail "git is not installed. The Xcode Command Line Tools installer was
    triggered - re-run this script when it finishes. Or install Homebrew
    (https://brew.sh) and run: brew install git"
  fi
  pkg_install git || true
  if ! command -v git &>/dev/null; then
    fail "git could not be installed automatically. Install it manually:
    macOS:  brew install git   (or xcode-select --install)
    Linux:  sudo apt install git   (or dnf/yum/pacman/zypper/apk equivalent)
    Windows: winget install Git.Git"
  fi
  ok "git: $(git --version | head -1) (installed)"
}

# Windows (Git Bash): try scoop/choco/winget, else download the official
# ripgrep release zip straight into ~/.local/bin.
install_rg_windows() {
  if command -v scoop &>/dev/null; then
    info "Trying scoop install ripgrep..."
    scoop install ripgrep 2>/dev/null || true
  fi
  if ! command -v rg &>/dev/null && command -v choco &>/dev/null; then
    info "Trying choco install ripgrep..."
    choco install ripgrep -y 2>/dev/null || true
  fi
  if ! command -v rg &>/dev/null && command -v winget &>/dev/null; then
    info "Trying winget install ripgrep..."
    winget install --id BurntSushi.ripgrep.MSVC -e --silent       --accept-package-agreements --accept-source-agreements 2>/dev/null || true
  fi
  if command -v rg &>/dev/null; then return 0; fi

  info "Downloading ripgrep release zip..."
  local ver="14.1.1"
  local url="https://github.com/BurntSushi/ripgrep/releases/download/${ver}/ripgrep-${ver}-x86_64-pc-windows-msvc.zip"
  local tmp; tmp="$(mktemp -d)"
  if ! curl -fsSL "$url" -o "$tmp/rg.zip"; then
    rm -rf "$tmp"; return 1
  fi
  mkdir -p "$INSTALL_DIR"
  if command -v unzip &>/dev/null; then
    unzip -o -j "$tmp/rg.zip" "*/rg.exe" -d "$INSTALL_DIR" || { rm -rf "$tmp"; return 1; }
  else
    # Git Bash without unzip: ask PowerShell to expand the archive.
    local win_tmp win_dest
    win_tmp="$(cygpath -w "$tmp/rg.zip" 2>/dev/null || echo "$tmp/rg.zip")"
    win_dest="$(cygpath -w "$tmp" 2>/dev/null || echo "$tmp")"
    powershell.exe -NoProfile -Command       "Expand-Archive -Force '$win_tmp' '$win_dest'" || { rm -rf "$tmp"; return 1; }
    cp "$tmp"/ripgrep-*/rg.exe "$INSTALL_DIR/rg.exe" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  fi
  rm -rf "$tmp"
  command -v rg &>/dev/null || [ -f "$INSTALL_DIR/rg.exe" ]
}

check_rg() {
  if command -v rg &>/dev/null; then
    ok "rg: $(rg --version | head -1)"
    return
  fi
  info "ripgrep (rg) not found. Installing..."
  if [ "$OS" = "windows" ]; then
    install_rg_windows || true
  else
    pkg_install ripgrep || true
  fi
  # hash -r so a just-installed rg is picked up in this shell
  hash -r 2>/dev/null || true
  if command -v rg &>/dev/null; then
    ok "rg: $(rg --version | head -1) (installed)"
  elif [ -f "$INSTALL_DIR/rg.exe" ]; then
    ok "rg: installed to $INSTALL_DIR/rg.exe"
  else
    fail "ripgrep is required but could not be installed automatically. Install it manually:
    macOS:   brew install ripgrep
    Linux:   sudo apt install ripgrep   (or dnf/yum/pacman/zypper/apk equivalent)
    Windows: winget install BurntSushi.ripgrep.MSVC   (or scoop/choco install ripgrep)"
  fi
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  local newer
  newer="$(printf '%s\n' "$1" "$2" | sort -V | tail -1)"
  [ "$newer" = "$1" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required. Upgrading..."
  else
    info "bun not found. Installing..."
  fi
  install_bun
}

install_bun() {
  # `</dev/null` goes on the outer curl, not on bash: bash needs the pipe as
  # stdin to read the install script, so redirecting ITS stdin to /dev/null
  # makes it exit immediately with "Failure writing output to destination"
  # on the curl side.
  curl -fsSL https://bun.sh/install </dev/null | bash
  # Source the updated profile so bun is on PATH for this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation succeeded but binary not found on PATH.
    Add this to your shell profile and restart:
      export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Clone & build
# -------------------------------------------------------------------

# Fetch or refresh the source cache.
#
# GIT_TERMINAL_PROMPT=0 is essential: without it a stale cache with a bad
# remote makes git block on a credential prompt it can never receive (stdin is
# the curl pipe), which looks exactly like a hang. On any pull failure we throw
# the cache away and re-clone rather than building from a half-updated tree.
clone_repo() {
  export GIT_TERMINAL_PROMPT=0
  export GIT_ASKPASS=/bin/echo
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

  if [ -d "$BUILD_DIR/.git" ]; then
    info "Refreshing existing source cache ($BUILD_DIR)..."
    if git -C "$BUILD_DIR" fetch --depth 1 origin main </dev/null 2>&1 &&
       git -C "$BUILD_DIR" reset --hard FETCH_HEAD </dev/null >/dev/null 2>&1; then
      ok "Source cache updated"
      ok "Source cache: $BUILD_DIR"
      return
    fi
    warn "Could not refresh the cache — re-cloning from scratch"
    rm -rf "$BUILD_DIR"
  elif [ -d "$BUILD_DIR" ]; then
    warn "$BUILD_DIR exists but is not a git checkout — replacing it"
    rm -rf "$BUILD_DIR"
  fi

  info "Cloning repository to cache (this can take a minute)..."
  git clone --depth 1 "$REPO" "$BUILD_DIR" </dev/null ||
    fail "git clone failed. Check your network/proxy and that $REPO is reachable."
  ok "Source cache: $BUILD_DIR"
}

install_deps() {
  info "Installing dependencies (several hundred MB, a few minutes on a cold cache)..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun install --frozen-lockfile </dev/null || bun install </dev/null ||
    fail "bun install failed. Re-run with a working network, or inspect $BUILD_DIR."
  ok "Dependencies installed"
}

build_bundle() {
  info "Building cclite (JS bundle, ~1 minute)..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun run build:bundle:cclite </dev/null
  [ -f "$BUILD_DIR/cclite.js" ] || fail "Build did not produce cclite.js."
  # Small standalone verifier shipped next to the bundle so users can re-check
  # the embedding model at any time via `cclite-verify-embeddings`.
  bun run build:bundle:verify </dev/null || warn "Could not build the embeddings verifier (non-fatal)"
  ok "Bundle built: $BUILD_DIR/cclite.js"
}

# Install the runtime home: the JS bundle plus a minimal node_modules that
# carries the local semantic embedding stack (Transformers.js + ONNX Runtime).
install_lib() {
  info "Installing runtime to $LIB_DIR..."
  mkdir -p "$LIB_DIR"
  cp "$BUILD_DIR/cclite.js" "$LIB_DIR/cclite.js"
  [ -f "$BUILD_DIR/verify-embeddings.js" ] &&
    cp "$BUILD_DIR/verify-embeddings.js" "$LIB_DIR/verify-embeddings.js"

  # Minimal manifest: only the embedding stack is resolved at runtime; every
  # other dependency is already inlined in the bundle.
  cat > "$LIB_DIR/package.json" <<EOF
{
  "name": "cclite-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@huggingface/transformers": "${TRANSFORMERS_VERSION}"
  }
}
EOF

  info "Installing the local semantic embedding model runtime (~130MB download, be patient)..."
  cd "$LIB_DIR" || fail "Cannot enter $LIB_DIR"
  # --trust: onnxruntime-node's postinstall picks the platform binary.
  bun install --trust </dev/null || bun install </dev/null || {
    warn "Could not install the embedding runtime."
    warn "Semantic search will fall back to approximate matching."
    return 0
  }
  trim_lib
  ok "Runtime installed: $LIB_DIR"
}

# Drop what the embedding path never loads: sourcemaps, type stubs, the
# browser ONNX build, and the two foreign-platform native binaries.
trim_lib() {
  local before after
  before="$(du -sm "$LIB_DIR/node_modules" 2>/dev/null | cut -f1)"
  find "$LIB_DIR/node_modules" -name "*.map" -delete 2>/dev/null || true
  rm -rf "$LIB_DIR/node_modules/@types" 2>/dev/null || true
  rm -rf "$LIB_DIR/node_modules/onnxruntime-web" 2>/dev/null || true
  local napi="$LIB_DIR/node_modules/onnxruntime-node/bin/napi-v3"
  if [ -d "$napi" ]; then
    local keep=""
    case "$OS" in
      linux)   keep="linux"  ;;
      macos)   keep="darwin" ;;
      windows) keep="win32"  ;;
    esac
    local d
    for d in "$napi"/*; do
      [ -d "$d" ] || continue
      [ "$(basename "$d")" = "$keep" ] || rm -rf "$d"
    done
  fi
  after="$(du -sm "$LIB_DIR/node_modules" 2>/dev/null | cut -f1)"
  if [ -n "$before" ] && [ -n "$after" ]; then
    info "Trimmed runtime: ${before}MB -> ${after}MB"
  fi
}

# Download + smoke-test the embedding model so the first search is instant
# and the user sees proof that real semantic search works.
prefetch_model() {
  [ -f "$LIB_DIR/verify-embeddings.js" ] || return 0
  info "Downloading the semantic model (~23MB, one time) and verifying — no output for a while is normal..."
  cd "$LIB_DIR" || return 0
  if bun ./verify-embeddings.js </dev/null; then
    ok "Semantic search ready"
  else
    warn "Model prefetch/verification failed - semantic search will fall back"
    warn "to approximate matching. Re-run later: cclite-verify-embeddings"
  fi
}

# cclite / cclite-bypass / cclite-verify-embeddings are thin shell wrappers
# that exec `bun` against the installed bundle, with cwd-independent paths.
install_launchers() {
  local main="$INSTALL_DIR/cclite"
  # No `cd` here: cclite must run against the user's current directory.
  # Bun resolves node_modules from the entry script's location, so the
  # embedding stack in $LIB_DIR is found regardless of cwd.
  cat > "$main" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export BUN_INSTALL="\${BUN_INSTALL:-\$HOME/.bun}"
export PATH="\$BUN_INSTALL/bin:\$PATH"
exec bun "${LIB_DIR}/cclite.js" "\$@"
EOF
  chmod +x "$main" 2>/dev/null || true
  ok "Installed: $main"

  local bypass="$INSTALL_DIR/cclite-bypass"
  cat > "$bypass" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export IS_SANDBOX=1
exec "${INSTALL_DIR}/cclite" --permission-mode bypassPermissions "\$@"
EOF
  chmod +x "$bypass" 2>/dev/null || true
  ok "Installed: $bypass"

  # ccliteweb: same CLI, but opens the local config WebUI directly.
  local web="$INSTALL_DIR/ccliteweb"
  cat > "$web" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${INSTALL_DIR}/cclite" web "\$@"
EOF
  chmod +x "$web" 2>/dev/null || true
  ok "Installed: $web"

  if [ -f "$LIB_DIR/verify-embeddings.js" ]; then
    local verify="$INSTALL_DIR/cclite-verify-embeddings"
    cat > "$verify" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export BUN_INSTALL="\${BUN_INSTALL:-\$HOME/.bun}"
export PATH="\$BUN_INSTALL/bin:\$PATH"
exec bun "${LIB_DIR}/verify-embeddings.js" "\$@"
EOF
    chmod +x "$verify" 2>/dev/null || true
    ok "Installed: $verify"
  fi
}

# Ensure INSTALL_DIR is on PATH: persist it to the user's shell profiles
# (idempotently) and export it for the current session.
add_to_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return ;;
  esac

  local line='export PATH="$HOME/.local/bin:$PATH"'
  local added="" present=""
  local profile
  for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$profile" ] || continue
    if grep -qF "$line" "$profile" 2>/dev/null; then
      present="yes"
    else
      printf '\n# Added by cclite installer\n%s\n' "$line" >> "$profile"
      added="$added $profile"
    fi
  done

  # No profile existed at all: create ~/.profile so it applies on next login.
  if [ -z "$added" ] && [ -z "$present" ]; then
    printf '# Added by cclite installer\n%s\n' "$line" >> "$HOME/.profile"
    added=" $HOME/.profile"
  fi

  # Make cclite usable in the current shell immediately.
  export PATH="$INSTALL_DIR:$PATH"

  if [ -n "$added" ]; then
    ok "Added $INSTALL_DIR to PATH in:$added"
  fi
  warn "Open a new terminal (or run: source ~/.bashrc) to use 'cclite' in existing shells."
}

install_binary() {
  mkdir -p "$INSTALL_DIR"

  install_lib
  install_launchers
  prefetch_model

  rm -rf "$BUILD_DIR"
  ok "Build cache cleaned"

  add_to_path
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

header
info "Starting installation..."
echo ""

check_os
check_git
check_bun
check_rg
echo ""

clone_repo
install_deps
build_bundle
install_binary

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}cclite${RESET}                           # interactive REPL\n"
printf "    ${CYAN}cclite-bypass${RESET}                    # interactive REPL with bypassPermissions\n"
printf "    ${CYAN}cclite -p \"your prompt\"${RESET}          # one-shot mode\n"
printf "    ${CYAN}cclite-verify-embeddings${RESET}          # re-check the local semantic model\n"
printf "    ${CYAN}ccliteweb${RESET}                     # WebUI at 127.0.0.1:1511 - providers + pro/plus/se models\n"
echo ""
printf "  ${BOLD}Recommended: configure providers via the local WebUI:${RESET}\n"
printf "    ${CYAN}ccliteweb${RESET}    # save several providers, then bind the pro / plus / se models\n"
printf "                     # pro  = main loop, plus = advisor, se = subagents\n"
printf "                     # saving applies on the next request - no restart\n"
printf "                     # busy port? it scans upward, or use: ccliteweb --port 1600\n"
echo ""
printf "  ${BOLD}Or set your API key via env vars:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Also support OpenAI Chat Completions APIs (env, or use `ccliteweb`):${RESET}\n"
printf "    ${CYAN}export CLAUDE_CODE_USE_OPENAI=1${RESET}\n"
printf "    ${CYAN}export OPENAI_BASE_URL=http://.../v1${RESET}\n"
echo ""
printf "  ${BOLD}See README.md for full configs.${RESET}\n"
echo ""

# Line-buffered wrappers (systemd-run, CI, `bash <(curl ...)`) can hold the
# script's stdout open after the last printf flushes. Exit explicitly so the
# shell reaps its runtime instead of sitting there until a stray EOF.
exit 0
