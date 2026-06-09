#!/bin/bash
echo "=== Starting plugin installation script ==="

set -euo pipefail

PACKAGE_TAR="${1:-}"
PLUGIN_FILE="${2:-}"
CFG_DIR="/boot/config/plugins/docker.networks"
CFG_FILE="$CFG_DIR/docker.networks.cfg"
CFG_BACKUP="/tmp/docker.networks.cfg.backup"

if [[ -z "$PACKAGE_TAR" || -z "$PLUGIN_FILE" ]]; then
  echo "Usage: $0 <package_tar> <plugin_plg>"
  exit 2
fi

mkdir -p /boot/config/plugins

if [[ -f "$CFG_FILE" ]]; then
  echo "=== Backing up existing config ==="
  cp -- "$CFG_FILE" "$CFG_BACKUP"
fi

echo "=== Uninstalling plugin via 'plugin remove docker.networks.plg' ==="
if plugin remove docker.networks.plg; then
  echo "=== 'plugin remove' succeeded ==="
else
  echo "=== 'plugin remove' failed, trying fallback removepkg ==="
  removepkg docker.networks || true
fi

for pkg in /var/log/packages/docker.networks-*; do
  if [[ -e "$pkg" ]]; then
    removepkg "$(basename "$pkg")" 2>/dev/null || true
  fi
done

cp -- "$PLUGIN_FILE" "/boot/config/plugins/$(basename "$PLUGIN_FILE")"
if plugin install "/boot/config/plugins/$(basename "$PLUGIN_FILE")" forced; then
  if [[ -f "$CFG_BACKUP" ]]; then
    echo "=== Restoring saved config ==="
    mkdir -p "$CFG_DIR"
    mv -- "$CFG_BACKUP" "$CFG_FILE"
  fi
  echo "=== plugin install succeeded ==="
  exit 0
fi

echo "=== plugin install failed, trying upgradepkg fallback ==="
mkdir -p "$CFG_DIR"
cp -- "$PACKAGE_TAR" "$CFG_DIR/$(basename "$PACKAGE_TAR")"
upgradepkg --install-new "$CFG_DIR/$(basename "$PACKAGE_TAR")"

if [[ -f "$CFG_BACKUP" ]]; then
  echo "=== Restoring saved config after fallback install ==="
  mv -- "$CFG_BACKUP" "$CFG_FILE"
fi
