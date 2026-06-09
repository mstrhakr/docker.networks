#!/bin/bash
set -euo pipefail

[ -z "${OUTPUT_FOLDER:-}" ] && echo "Output folder not set" && exit 1
[ -z "${PKG_VERSION:-}" ] && echo "Package version not set" && exit 2
[ -z "${PKG_BUILD:-}" ] && PKG_BUILD="$(date +%H%M)"

name="docker.networks"
version="$PKG_VERSION"
build="$PKG_BUILD"
tmpdir="/tmp/tmp.$((RANDOM * 19318203981230 + 40))"

mkdir -p "$tmpdir"
mkdir -p "$tmpdir/usr/local/emhttp/plugins/$name"
cp -RT /mnt/source/docker.networks/ "$tmpdir/usr/local/emhttp/plugins/$name/"

chmod +x "$tmpdir/usr/local/emhttp/plugins/$name/include/Exec.php" || true

mkdir -p "$tmpdir/install"
cat > "$tmpdir/install/slack-desc" << 'EOF'
docker.networks: docker.networks
docker.networks:
docker.networks: Unraid plugin to manage custom docker networks.
docker.networks: Create, inspect, and remove networks from the web UI.
docker.networks: Includes API endpoints for docker network actions.
docker.networks:
docker.networks: https://github.com/mstrhakr/docker.networks
docker.networks:
docker.networks:
EOF

cd "$tmpdir"
makepkg -l y -c y "$OUTPUT_FOLDER/${name}-${version}-noarch-${build}.txz" <<< 'y'
cd /

md5sum "$OUTPUT_FOLDER/${name}-${version}-noarch-${build}.txz" > "$OUTPUT_FOLDER/release_info"
