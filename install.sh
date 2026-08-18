#!/usr/bin/env bash
set -euo pipefail

# cc-lite installer
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
BUILD_DIR="$HOME/.cache/cc-lite"
INSTALL_DIR="$HOME/.local/bin"
BUN_MIN_VERSION="1.3.11"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${ORANGE}"
  cat << 'ART'

_________   .__                         .___ .__
\_   ___ \  |  |   _____     __ __    __| _/ |__|  __ __    _____
/    \  \/  |  |   \__  \   |  |  \  / __ |  |  | |  |  \  /     \
\     \____ |  |__  / __ \_ |  |  / / /_/ |  |  | |  |  / |  Y Y  \
 \______  / |____/ (____  / |____/  \____ |  |__| |____/  |__|_|  /
        \/              \/               \/                     \/

ART
  printf "${RESET}"
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
pkg_install() {
  local name="$1" mgr
  mgr="$(detect_pkg_mgr)"
  [ -z "$mgr" ] && return 1
  local SUDO=""
  if [ "$(id -u)" -ne 0 ] && command -v sudo &>/dev/null; then SUDO="sudo"; fi
  info "Installing $name via $mgr..."
  case "$mgr" in
    apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y "$name" ;;
    dnf)    $SUDO dnf install -y "$name" ;;
    yum)    $SUDO yum install -y "$name" ;;
    pacman) $SUDO pacman -Sy --noconfirm "$name" ;;
    zypper) $SUDO zypper --non-interactive install "$name" ;;
    apk)    $SUDO apk add "$name" ;;
    brew)   brew install "$name" ;;
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
  curl -fsSL https://bun.sh/install | bash
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

clone_repo() {
  if [ -d "$BUILD_DIR" ]; then
    warn "$BUILD_DIR already exists"
    if [ -d "$BUILD_DIR/.git" ]; then
      info "Pulling latest changes..."
      git -C "$BUILD_DIR" pull --ff-only origin main 2>/dev/null || {
        warn "Pull failed, continuing with existing copy"
      }
    fi
  else
    info "Cloning repository to cache..."
    git clone --depth 1 "$REPO" "$BUILD_DIR"
  fi
  ok "Source cache: $BUILD_DIR"
}

install_deps() {
  info "Installing dependencies..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_binary() {
  info "Building cc-lite..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun run build:dev:cc-lite
  local binary="$BUILD_DIR/cc-lite-cli-dev${BIN_EXT}"
  if [ ! -f "$binary" ]; then
    binary="$BUILD_DIR/cc-lite-cli-dev"
    [ -f "$binary" ] || fail "Build did not produce cc-lite-cli-dev(.exe)."
  fi
  ok "Binary built: $binary"
}

install_bypass_launcher() {
  local launcher="$INSTALL_DIR/cc-lite-bypass"

  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd -- "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export IS_SANDBOX=1
exec "\$SCRIPT_DIR/cc-lite${BIN_EXT}" --permission-mode bypassPermissions "\$@"
EOF

  if [ "$OS" != "windows" ]; then
    chmod +x "$launcher"
  fi
  ok "Installed: $launcher"
}

install_binary() {
  mkdir -p "$INSTALL_DIR"

  cp "$BUILD_DIR/cc-lite-cli-dev${BIN_EXT}" "$INSTALL_DIR/cc-lite${BIN_EXT}"
  if [ "$OS" != "windows" ]; then
    chmod +x "$INSTALL_DIR/cc-lite${BIN_EXT}"
  fi
  ok "Installed: $INSTALL_DIR/cc-lite${BIN_EXT}"

  install_bypass_launcher

  rm -rf "$BUILD_DIR"
  ok "Build cache cleaned"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    warn "$INSTALL_DIR is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
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
build_binary
install_binary

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}cc-lite${RESET}                           # interactive REPL\n"
printf "    ${CYAN}cc-lite-bypass${RESET}                    # interactive REPL with bypassPermissions\n"
printf "    ${CYAN}cc-lite -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Set your Anthropic Messages API key:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Also support OpenAI Chat Completions APIs:${RESET}\n"
printf "    ${CYAN}export CLAUDE_CODE_USE_OPENAI=1${RESET}\n"
printf "    ${CYAN}export OPENAI_BASE_URL=http://.../v1${RESET}\n"
echo ""
printf "  ${BOLD}See README.md for full configs.${RESET}\n"
echo ""
