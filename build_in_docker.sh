#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

in_container=false
if [[ -f "/.dockerenv" ]] || grep -qE '/docker|/lxc|/kubepods' /proc/1/cgroup 2>/dev/null; then
  in_container=true
fi

to_host_visible_path() {
  local local_path="$1"
  local mount_point="$2"
  local fallback="$local_path"

  if [[ "$in_container" != true || ! -d "$mount_point" || "$local_path" != "$mount_point"* ]]; then
    echo "$fallback"
    return 0
  fi

  local host_root=""
  local host_source=""
  read -r host_root host_source < <(awk -v mnt="$mount_point" '$5==mnt {for(i=1;i<=NF;i++){if($i=="-"){print $4, $(i+2); exit}}}' /proc/self/mountinfo 2>/dev/null || true)

  if [[ -z "$host_root" || -z "$host_source" ]]; then
    echo "$fallback"
    return 0
  fi

  local host_base=""
  if [[ "$host_source" == "fuse.shfs" || "$host_source" == "shfs" ]]; then
    if [[ "$host_root" =~ ^/appdata(/.*)$ ]]; then
      host_base="/mnt/user/appdata${BASH_REMATCH[1]}"
    elif [[ "$host_root" =~ ^/mnt/user(/.*)$ ]]; then
      host_base="$host_root"
    else
      host_base="/mnt/user${host_root}"
    fi
  else
    host_base="${host_source%/}${host_root}"
  fi

  echo "$host_base${local_path#"${mount_point}"}"
}

[ -z "${PKG_VERSION:-}" ] && PKG_VERSION="$(date +%Y.%m.%d.%H%M)"
[ -z "${PKG_BUILD:-}" ] && PKG_BUILD="$(date +%H%M)"

mkdir -p "$SCRIPT_DIR/archive/.build-cache"

SOURCE_PATH="$SCRIPT_DIR/source"
ARCHIVE_PATH="$SCRIPT_DIR/archive"
CACHE_PATH="$SCRIPT_DIR/archive/.build-cache"

HOST_SOURCE_PATH="$(to_host_visible_path "$SOURCE_PATH" "/code")"
HOST_ARCHIVE_PATH="$(to_host_visible_path "$ARCHIVE_PATH" "/code")"
HOST_CACHE_PATH="$(to_host_visible_path "$CACHE_PATH" "/code")"

# Fallback for environments mounted under /config instead of /code.
if [[ "$HOST_SOURCE_PATH" == "$SOURCE_PATH" ]]; then
  HOST_SOURCE_PATH="$(to_host_visible_path "$SOURCE_PATH" "/config")"
fi
if [[ "$HOST_ARCHIVE_PATH" == "$ARCHIVE_PATH" ]]; then
  HOST_ARCHIVE_PATH="$(to_host_visible_path "$ARCHIVE_PATH" "/config")"
fi
if [[ "$HOST_CACHE_PATH" == "$CACHE_PATH" ]]; then
  HOST_CACHE_PATH="$(to_host_visible_path "$CACHE_PATH" "/config")"
fi

mkdir -p "$HOST_ARCHIVE_PATH" "$HOST_CACHE_PATH"

docker run --rm --tmpfs /tmp \
  -v "$HOST_ARCHIVE_PATH:/mnt/output:rw" \
  -v "$HOST_CACHE_PATH:/mnt/cache:rw" \
  -e TZ="America/New_York" \
  -e PKG_VERSION="$PKG_VERSION" \
  -e PKG_BUILD="$PKG_BUILD" \
  -e OUTPUT_FOLDER="/mnt/output" \
  -v "$HOST_SOURCE_PATH:/mnt/source:ro" \
  vbatts/slackware:latest \
  bash /mnt/source/pkg_build.sh
