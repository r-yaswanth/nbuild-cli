#!/usr/bin/env bash
set -euo pipefail

log() {
  printf "%s\n" "$*"
}

warn() {
  printf "%s\n" "WARN: $*" >&2
}

err() {
  printf "%s\n" "ERROR: $*" >&2
}

SPINNER_CHARS='|/-\'
spinner_active=0
spinner_pid=""

run_step() {
  local msg="$1"
  shift
  local log_file
  log_file="$(mktemp)"

  (
    while true; do
      for c in '|' '/' '-' '\\'; do
        printf "\r%s %s" "$c" "$msg"
        sleep 0.12
      done
    done
  ) &
  spinner_pid="$!"

  set +e
  "$@" >"$log_file" 2>&1
  local code=$?
  set -e

  if [[ -n "$spinner_pid" ]]; then
    kill "$spinner_pid" 2>/dev/null || true
    wait "$spinner_pid" 2>/dev/null || true
  fi
  spinner_pid=""

  if [[ "$code" -eq 0 ]]; then
    printf "\r✅ %s\n" "$msg"
    rm -f "$log_file" >/dev/null 2>&1 || true
    return 0
  fi

  printf "\r❌ %s\n" "$msg"
  err "Command failed: $*"
  err "---- output (tail) ----"
  tail -n 40 "$log_file" >&2 || true
  err "-----------------------"
  rm -f "$log_file" >/dev/null 2>&1 || true
  return "$code"
}

run_step_timeout() {
  # Args:
  #   $1 = message
  #   $2 = timeout seconds (integer)
  #   $@ = command
  local msg="$1"
  local timeout_secs="$2"
  shift 2

  if [[ -z "$timeout_secs" || ! "$timeout_secs" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  local log_file
  log_file="$(mktemp)"

  (
    while true; do
      for c in '|' '/' '-' '\\'; do
        printf "\r%s %s" "$c" "$msg"
        sleep 0.12
      done
    done
  ) &
  spinner_pid="$!"

  set +e
  "$@" >"$log_file" 2>&1 &
  local cmd_pid=$!

  local elapsed=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if (( elapsed >= timeout_secs )); then
      kill -9 "$cmd_pid" 2>/dev/null || true
      wait "$cmd_pid" 2>/dev/null || true
      local code=124
      set -e
      if [[ -n "$spinner_pid" ]]; then
        kill "$spinner_pid" 2>/dev/null || true
        wait "$spinner_pid" 2>/dev/null || true
      fi
      spinner_pid=""
      printf "\r❌ %s\n" "$msg"
      err "Timed out after ${timeout_secs}s."
      err "Debug log kept at: $log_file"
      return "$code"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$cmd_pid"
  local code=$?
  set -e

  if [[ -n "$spinner_pid" ]]; then
    kill "$spinner_pid" 2>/dev/null || true
    wait "$spinner_pid" 2>/dev/null || true
  fi
  spinner_pid=""

  if [[ "$code" -eq 0 ]]; then
    printf "\r✅ %s\n" "$msg"
    rm -f "$log_file" >/dev/null 2>&1 || true
    return 0
  fi

  printf "\r❌ %s\n" "$msg"
  err "Command failed: $*"
  err "---- output (tail) ----"
  tail -n 40 "$log_file" >&2 || true
  err "-----------------------"
  rm -f "$log_file" >/dev/null 2>&1 || true
  return "$code"
}

PACKAGE_NAME="nlearn-build"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    return 1
  fi
}

ensure_cmd() {
  # Args:
  #   $1 = command to check in PATH
  #   $2 = brew package to install (only used when brew exists)
  local cmd="$1"
  local pkg="${2:-}"

  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi

  if [[ -z "$pkg" ]]; then
    err "Missing $cmd, but no brew package mapping provided."
    return 1
  fi

  # Install Homebrew automatically if missing (best-effort).
  if ! command -v brew >/dev/null 2>&1; then
    if command -v curl >/dev/null 2>&1; then
      run_step "Installing Homebrew" bash -lc \
        "/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    else
      err "Homebrew and curl are both missing. Install Homebrew manually."
      return 1
    fi
  fi

  warn "Missing $cmd. Installing with Homebrew: $pkg"
  brew install "$pkg"
  return 0
}

node_major() {
  # Example: v20.11.1 -> 20
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

require_env() {
  # If any command is missing from PATH, auto-install via Homebrew (when present)
  ensure_cmd node node
  ensure_cmd npm node
  ensure_cmd git git

  local major
  major="$(node_major)"
  if [[ -z "$major" ]]; then
    err "Could not parse Node.js version."
    return 1
  fi
  # Node 18+ is the safe baseline for modern npm + fetch behavior.
  if (( major < 18 )); then
    run_step "Upgrading Node.js (>=18) via brew" brew install node
  fi
}

ensure_firebase() {
  if command -v firebase >/dev/null 2>&1; then
    return 0
  fi

  local npm_prefix="$HOME/.npm-global"
  mkdir -p "$npm_prefix"

  # Use a fresh temp cache for this install so corrupted caches
  # (like tar ENOENT) don't break the install.
  local tmp_cache
  tmp_cache="$(mktemp -d)"

  # Install firebase-tools in user-local prefix to keep it clean.
  run_step "Installing Firebase CLI (firebase-tools)" \
    env npm_config_prefix="$npm_prefix" npm install -g firebase-tools --no-audit --no-fund --cache "$tmp_cache"

  rm -rf "$tmp_cache" >/dev/null 2>&1 || true

  export PATH="$npm_prefix/bin:$PATH"

  if ! command -v firebase >/dev/null 2>&1; then
    err "Firebase CLI installed, but `firebase` command not found in PATH."
    return 1
  fi

  return 0
}

ensure_flutter_and_flutterfire() {
  if command -v flutterfire >/dev/null 2>&1; then
    return 0
  fi

  local FLUTTER_HOME="${NBBUILD_FLUTTER_HOME:-$HOME/flutter}"

  # Install Flutter SDK if flutter command is missing.
  if ! command -v flutter >/dev/null 2>&1; then
    if [[ ! -d "$FLUTTER_HOME/.git" ]]; then
      run_step "Cloning Flutter SDK (stable)" \
        git clone https://github.com/flutter/flutter.git -b stable "$FLUTTER_HOME"
    else
      run_step "Updating Flutter SDK" \
        git -C "$FLUTTER_HOME" fetch --all --prune
      run_step "Checking out Flutter stable" \
        git -C "$FLUTTER_HOME" checkout stable
    fi
  fi

  export PATH="$FLUTTER_HOME/bin:$PATH"

  run_step "Running flutter precache (for tooling)" \
    "$FLUTTER_HOME/bin/flutter" precache

  # Activate flutterfire_cli (provides `flutterfire`)
  export PATH="$HOME/.pub-cache/bin:$PATH"
  run_step "Activating flutterfire_cli" \
    "$FLUTTER_HOME/bin/dart" pub global activate flutterfire_cli

  export PATH="$HOME/.pub-cache/bin:$PATH"

  if ! command -v flutterfire >/dev/null 2>&1; then
    err "`flutterfire` not found even after activation."
    return 1
  fi

  return 0
}

detect_origin_url() {
  # Try to read origin url from a git repo context (this file runs best inside repo).
  if [[ ! -f ".git/config" ]]; then
    return 0
  fi

  local url
  url="$(awk '
    $0 ~ /^\\[remote "origin"\\]/ {in_origin=1; next}
    in_origin && $0 ~ /^url =/ {
      sub(/^url = /, "", $0); print $0; exit
    }
    in_origin && $0 ~ /^\\[/ {exit}
  ' .git/config || true)"

  if [[ -n "$url" ]]; then
    # Normalize git@github.com:user/repo.git to https://github.com/user/repo.git
    if [[ "$url" =~ ^git@([^:]+):(.+)$ ]]; then
      printf "https://%s/%s\n" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      return 0
    fi
    if [[ "$url" =~ ^ssh://git@([^/]+)/(.+)$ ]]; then
      printf "https://%s/%s\n" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      return 0
    fi
    printf "%s\n" "$url"
  fi
}

main() {
  require_env

  log "Ensuring Firebase CLI..."
  ensure_firebase
  log "Ensuring flutterfire..."
  ensure_flutter_and_flutterfire

  # Some environments may make `firebase --version` hang (rare).
  # Do a timeout so installation still completes cleanly.
  if ! run_step_timeout "Checking firebase version" 20 firebase --version; then
    warn "firebase --version timed out; continuing install."
  fi
  if ! run_step_timeout "Checking flutterfire version" 20 flutterfire --version; then
    warn "flutterfire --version timed out; continuing install."
  fi

  # Default git source for this CLI.
  # Override via env vars if you want.
  local DEFAULT_GIT_URL="https://github.com/r-yaswanth/nbuild-cli.git"
  local DEFAULT_GIT_REF="main"

  local git_url="${NBBUILD_GIT_URL:-$DEFAULT_GIT_URL}"
  local git_ref="${NBBUILD_GIT_REF:-$DEFAULT_GIT_REF}"

  if [[ -z "$git_url" ]]; then
    git_url="$(detect_origin_url || true)"
  fi

  if [[ -z "$git_url" ]]; then
    err "Git URL not found. Set NBBUILD_GIT_URL to install."
    err "Example:"
    err "  NBBUILD_GIT_URL=https://github.com/<user>/<repo>.git ./install.sh"
    exit 1
  fi

  if [[ -z "$git_ref" ]]; then
    if git rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
      git_ref="$(git rev-parse --abbrev-ref HEAD || true)"
    fi
  fi

  local workdir="${NBBUILD_WORKDIR:-$HOME/.nbuild-cli-src}"
  local bin_dir="${NBBUILD_BIN_DIR:-$HOME/.nbuild/bin}"
  local install_src="$workdir"
  local tmp_cache

  log "Cloning/updating source..."
  log "Source dir: $install_src"
  log "Installing binary to: $bin_dir"

  if [[ -d "$install_src/.git" ]]; then
    run_step "Updating CLI source (git fetch)" \
      git -C "$install_src" fetch --all --prune
  else
    rm -rf "$install_src"
    run_step "Cloning CLI source" \
      git clone "$git_url" "$install_src"
  fi

  if [[ -n "$git_ref" ]]; then
    if ! git -C "$install_src" checkout "$git_ref" >/dev/null 2>&1; then
      warn "Could not checkout ref '$git_ref' directly; fetching it..."
      run_step "Fetching git tags" git -C "$install_src" fetch --all --tags
      run_step "Checking out git ref" git -C "$install_src" checkout "$git_ref"
    fi
  fi

  tmp_cache="$(mktemp -d)"
  trap 'rm -rf "$tmp_cache" >/dev/null 2>&1 || true' EXIT

  run_step "Installing CLI npm deps" bash -lc \
    "cd \"$install_src\" && npm install --no-audit --no-fund --cache \"$tmp_cache\" --prefix \"$install_src\""

  run_step "Building CLI (tsc + dist)" bash -lc \
    "cd \"$install_src\" && npm run build --silent"

  local bin_src="$install_src/dist/index.js"
  if [[ ! -f "$bin_src" ]]; then
    err "Build did not produce dist/index.js at: $bin_src"
    exit 1
  fi

  mkdir -p "$bin_dir"
  ln -sf "$bin_src" "$bin_dir/nbuild"
  chmod +x "$bin_dir/nbuild" 2>/dev/null || true

  export PATH="$bin_dir:$PATH"

  if command -v nbuild >/dev/null 2>&1; then
    log "Installed. Version:"
    nbuild --version || true
  else
    warn "Binary linked, but nbuild not found in PATH for this session."
    warn "Add to PATH:"
    warn "  export PATH=\"$bin_dir:\$PATH\""
  fi

  log "Done."
  log "CLI source: $workdir"
  log "CLI binary: $bin_dir/nbuild"
}

main "$@"

