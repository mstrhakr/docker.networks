#!/bin/bash
set -euo pipefail
trap 'echo "ERROR: command failed on line $LINENO" >&2' ERR

VERSION=""
DEV=false
REMOTE_HOSTS=()
USER_NAME="root"
REMOTE_DIR="/tmp"
PACKAGE_PATH=""
SKIP_BUILD=false
QUICK=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_DIR="$SCRIPT_DIR/archive"

usage() {
  cat <<EOF
Usage: $0 [options]
  -Version <version>
  -Dev
  -RemoteHost <host1,host2,...>
  -User <ssh-user>
  -RemoteDir <remote-dir>
  -PackagePath <package.txz>
  -SkipBuild
  -Quick
  -Help
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -Version|--Version)
      VERSION="$2"; shift 2;;
    -Dev|--Dev)
      DEV=true; shift;;
    -RemoteHost|--RemoteHost)
      IFS=',' read -r -a REMOTE_HOSTS <<< "$2"; shift 2;;
    -User|--User)
      USER_NAME="$2"; shift 2;;
    -RemoteDir|--RemoteDir)
      REMOTE_DIR="$2"; shift 2;;
    -PackagePath|--PackagePath)
      PACKAGE_PATH="$2"; shift 2;;
    -SkipBuild|--SkipBuild)
      SKIP_BUILD=true; shift;;
    -Quick|--Quick)
      QUICK=true; shift;;
    -Help|--Help|-h)
      usage;;
    *)
      echo "Unknown option $1"; usage;;
  esac
done

if [[ "$QUICK" == true ]]; then
  [[ ${#REMOTE_HOSTS[@]} -eq 0 ]] && echo "RemoteHost required for -Quick" && exit 1

  REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)
  [[ -z "$REPO_ROOT" ]] && echo "Unable to resolve repository root" && exit 1

  QUICK_PREFIX="source/docker.networks/"
  QUICK_REMOTE_ROOT="/usr/local/emhttp/plugins/docker.networks"

  # staged: what’s in the index vs HEAD
  mapfile -t STAGED < <(git -C "$REPO_ROOT" diff --name-only --diff-filter=ACMR --cached -- "$QUICK_PREFIX")

  # unstaged: what’s in working tree vs index
  mapfile -t UNSTAGED < <(git -C "$REPO_ROOT" diff --name-only --diff-filter=ACMR -- "$QUICK_PREFIX")
  # (keep tracked-only behavior; if you want to include untracked, you’d need a different command)

  # union
  mapfile -t CHANGED_FILES < <(printf '%s\n' "${UNSTAGED[@]}" "${STAGED[@]}" | sort -u)
  
  [[ ${#CHANGED_FILES[@]} -eq 0 ]] && echo "No tracked changes under source/docker.networks" && exit 0

  for host in "${REMOTE_HOSTS[@]}"; do
    target="$USER_NAME@$host"
    echo "Quick deploy to $target"
    for relative in "${CHANGED_FILES[@]}"; do
      [[ $relative == $QUICK_PREFIX* ]] || continue
      subpath=${relative#"$QUICK_PREFIX"}
      local_path="$REPO_ROOT/$relative"
      [[ ! -f "$local_path" ]] && continue
      remote_file="$QUICK_REMOTE_ROOT/$subpath"
      remote_parent=$(dirname "$remote_file")
      ssh "$target" mkdir -p "$remote_parent"
      scp "$local_path" "$target:$remote_file"
    done
  done

  echo "Quick deployment complete."
  exit 0
fi

if [[ -n "$PACKAGE_PATH" ]]; then
  [[ ! -f "$PACKAGE_PATH" ]] && echo "PackagePath not found: $PACKAGE_PATH" && exit 1
  PACKAGE_PATH=$(realpath "$PACKAGE_PATH")
else
  if [[ "$SKIP_BUILD" == true ]]; then
    shopt -s nullglob
    files=("$ARCHIVE_DIR"/docker.networks-*-noarch-*.txz)
    shopt -u nullglob
    [[ ${#files[@]} -eq 0 ]] && echo "No package found in archive" && exit 1
    PACKAGE_PATH=$(printf '%s\n' "${files[@]}" | sort -r | head -n1)
  else
    build_args=()
    [[ -n "$VERSION" ]] && build_args+=("-Version" "$VERSION")
    [[ "$DEV" == true ]] && build_args+=("-Dev")
    bash "$SCRIPT_DIR/build.sh" "${build_args[@]}"

    shopt -s nullglob
    files=("$ARCHIVE_DIR"/docker.networks-*-noarch-*.txz)
    shopt -u nullglob
    [[ ${#files[@]} -eq 0 ]] && echo "Build completed but package not found" && exit 1
    PACKAGE_PATH=$(printf '%s\n' "${files[@]}" | sort -r | head -n1)
    PACKAGE_PATH=$(realpath "$PACKAGE_PATH")
  fi
fi

PACKAGE_NAME=$(basename "$PACKAGE_PATH")

if [[ ${#REMOTE_HOSTS[@]} -eq 0 ]]; then
  echo "No RemoteHost specified. Build only. Package: $PACKAGE_PATH"
  exit 0
fi

for cmd in ssh scp; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command missing: $cmd"; exit 1; }
done

PLUGIN_PATH="$SCRIPT_DIR/archive/docker.networks.plg"
[[ ! -f "$PLUGIN_PATH" ]] && PLUGIN_PATH="$SCRIPT_DIR/docker.networks.plg"
INSTALL_SCRIPT_LOCAL="$SCRIPT_DIR/install.sh"

for host in "${REMOTE_HOSTS[@]}"; do
  target="$USER_NAME@$host"
  remote_package="$REMOTE_DIR/$PACKAGE_NAME"
  remote_plugin="$REMOTE_DIR/$(basename "$PLUGIN_PATH")"
  remote_install_script="$REMOTE_DIR/install.sh"

  echo "Deploying to $target"
  scp "$PACKAGE_PATH" "$target:$REMOTE_DIR/"
  scp "$PLUGIN_PATH" "$target:$REMOTE_DIR/"
  scp "$INSTALL_SCRIPT_LOCAL" "$target:$remote_install_script"

  ssh "$target" 'bash -s' -- "$remote_install_script" "$remote_package" "$remote_plugin" <<'EOF'
set -euo pipefail
bash "$1" "$2" "$3"
rm -f "$1"
EOF
  echo "Deployment complete to $host"
done
