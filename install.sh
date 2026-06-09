#!/bin/bash
echo "=== Starting plugin installation script ==="

set -euo pipefail

PACKAGE_TAR="${1:-}"
PLUGIN_FILE="${2:-}"

if [[ -z "$PACKAGE_TAR" || -z "$PLUGIN_FILE" ]]; then
  echo "Usage: $0 <package_tar> <plugin_plg>"
  exit 2
fi

mkdir -p /boot/config/plugins

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
  echo "=== plugin install succeeded ==="
  exit 0
fi

echo "=== plugin install failed, trying upgradepkg fallback ==="
mkdir -p /boot/config/plugins/docker.networks
cp -- "$PACKAGE_TAR" "/boot/config/plugins/docker.networks/$(basename "$PACKAGE_TAR")"
upgradepkg --install-new "/boot/config/plugins/docker.networks/$(basename "$PACKAGE_TAR")"
