#!/usr/bin/env bash
set -euo pipefail

# cclite dev installer — builds from the dev branch, installs as cclite
# Usage: curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install_dev.sh | bash

# Override these two before sourcing the shared install logic
BRANCH="dev"
BUILD_DIR="$HOME/.cache/cclite-dev"

# Everything below is the same as install.sh, only using $BRANCH / $BUILD_DIR.
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
ORANGE='\033[38;5;208m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="https://github.com/Flybicy/CC-lite.git"
INSTALL_DIR="$HOME/.local/bin"
# Runtime home for the JS bundle + the local semantic embedding stack.
LIB_DIR="$HOME/.local/lib/cclite"
BUN_MIN_VERSION="1.3.11"
# Pinned: must match the repo's package.json/bun.lock.
TRANSFORMERS_VERSION="3.8.1"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${CYAN}CC-lite${RESET}${YELLOW} (dev)${RESET} installer"
  echo ""
  printf "  ${DIM}Installs from the ${BOLD}dev${RESET}${DIM} branch.${RESET}"
  echo ""
  echo ""
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS or Linux required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    fail "git is not installed. Install it first:
    macOS:  xcode-select --install
    Linux:  sudo apt install git  (or your distro's equivalent)"
  fi
  ok "git: $(git --version | head -1)"
}

check_rg() {
  if ! command -v rg &>/dev/null; then
    warn "ripgrep (rg) not found — install it for best results:
    macOS:  brew install ripgrep
    Linux:  sudo apt install ripgrep"
  else
    ok "rg: $(rg --version | head -1)"
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
      info "Pulling latest changes from $BRANCH..."
      git -C "$BUILD_DIR" fetch origin "$BRANCH" 2>/dev/null
      git -C "$BUILD_DIR" checkout "$BRANCH" 2>/dev/null || true
      git -C "$BUILD_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || {
        warn "Pull failed, continuing with existing copy"
      }
    fi
  else
    info "Cloning repository ($BRANCH branch) to cache..."
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$BUILD_DIR"
  fi
  ok "Source cache: $BUILD_DIR ($BRANCH branch)"
}

install_deps() {
  info "Installing dependencies..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_bundle() {
  info "Building cclite (JS bundle)..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun run build:bundle:cclite
  [ -f "$BUILD_DIR/cclite.js" ] || fail "Build did not produce cclite.js."
  bun run build:bundle:verify || warn "Could not build the embeddings verifier (non-fatal)"
  ok "Bundle built: $BUILD_DIR/cclite.js"
}

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

prefetch_model() {
  [ -f "$LIB_DIR/verify-embeddings.js" ] || return 0
  info "Downloading the semantic model (~23MB, one time) and verifying..."
  cd "$LIB_DIR" || return 0
  if bun ./verify-embeddings.js; then
    ok "Semantic search ready"
  else
    warn "Model prefetch/verification failed - semantic search will fall back"
    warn "to approximate matching. Re-run later: cclite-verify-embeddings"
  fi
}

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
info "Starting dev installation..."
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
echo ""
printf "  ${BOLD}Set your API key:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Also support OpenAI Chat Completions APIs:${RESET}\n"
printf "    ${CYAN}export CLAUDE_CODE_USE_OPENAI=1${RESET}\n"
printf "    ${CYAN}export OPENAI_BASE_URL=http://.../v1${RESET}\n"
echo ""
printf "  ${BOLD}See README.md for full configs.${RESET}\n"
echo ""
