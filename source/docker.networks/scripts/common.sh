#!/bin/bash
# Shared logging helper for docker.networks shell scripts.
# Usage: dockerNetworksLogger "message" [level] [category] [type]

set -u

dockerNetworksLogger() {
  local msg="$1"
  local level="${2:-info}"
  local category="${3:-}"
  local type="${4:-user}"

  local priority="${type}.info"
  local display="[INFO]"

  case "$level" in
    debug)
      priority="${type}.debug"
      display="[DEBUG]"
      ;;
    error|err)
      priority="${type}.err"
      display="[ERROR]"
      ;;
    warning|warn)
      priority="${type}.warning"
      display="[WARN]"
      ;;
  esac

  local prefix="$display"
  if [[ -n "$category" ]]; then
    prefix="$prefix [$category]"
  fi

  logger -t 'docker.networks' -p "$priority" "$prefix $msg"
}
