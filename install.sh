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

  if command -v brew >/dev/null 2>&1; then
    if [[ -z "$pkg" ]]; then
      err "Missing $cmd, but no brew package mapping provided."
      return 1
    fi

    warn "Missing $cmd. Installing with Homebrew: $pkg"
    brew install "$pkg"
    return 0
  fi

  err "Missing required command: $cmd"
  err "Install it manually, or install Homebrew then re-run this script."
  return 1
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
    err "Node.js >= 18 is required. Found: $(node -v)"
    return 1
  fi
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

  log "Installing nbuild from: $git_url${git_ref:+#${git_ref}}"
  # npm git install spec: <repo-url>#<ref> works for branches/tags/commits.
  local spec="$git_url"
  if [[ -n "$git_ref" ]]; then
    spec="${git_url}#${git_ref}"
  fi

  # Install globally
  npm install -g "$spec"

  if command -v nbuild >/dev/null 2>&1; then
    log "Installed. Checking version..."
    nbuild --version || true
  else
    warn "Installed, but nbuild is not in PATH."
    warn "Your global npm bin is: $(npm bin -g 2>/dev/null || true)"
    warn "Add it to PATH or restart your shell."
  fi
}

main "$@"

