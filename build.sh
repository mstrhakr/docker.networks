#!/bin/bash
set -euo pipefail

VERSION=""
DEV=false
SKIP_TESTS=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_PATH="$SCRIPT_DIR/archive"
PLG_FILE="$SCRIPT_DIR/docker.networks.plg"

while [[ $# -gt 0 ]]; do
  case $1 in
    -Version|--Version)
      VERSION="$2"; shift 2;;
    -Dev|--Dev)
      DEV=true; shift;;
    -SkipTests|--SkipTests)
      SKIP_TESTS=true; shift;;
    *)
      echo "Unknown argument: $1"; exit 1;;
  esac
done

if [[ -f "$SCRIPT_DIR/test.sh" && "$SKIP_TESTS" == false ]]; then
  echo "Running tests..."
  bash "$SCRIPT_DIR/test.sh"
fi

if [[ "$DEV" == true ]]; then
  VERSION="$(date +'%Y.%m.%d.%H%M')"
  echo "Generated dev version: $VERSION"
fi

if [[ -z "$VERSION" && -f "$PLG_FILE" ]]; then
  VERSION=$(grep -oP 'ENTITY version\s+"\K[^"]+' "$PLG_FILE" | head -n1)
  [[ -z "$VERSION" ]] && echo "Could not determine version. Use -Version." && exit 1
  echo "Using version from .plg file: $VERSION"
fi

if [[ "$VERSION" =~ [0-9]{4}\.[0-9]{2}\.[0-9]{2}\.(\d{4})$ ]]; then
  BUILD_NUM="${BASH_REMATCH[1]}"
else
  BUILD_NUM="$(date +'%H%M')"
fi

PACKAGE_BASENAME="docker.networks-$VERSION-noarch-$BUILD_NUM"
PACKAGE_NAME="$PACKAGE_BASENAME.txz"
mkdir -p "$OUTPUT_PATH"

TEMP_PLG="$OUTPUT_PATH/docker.networks.plg"

SED_SCRIPT=$(mktemp)
cat > "$SED_SCRIPT" <<SEDEOF
s|^\s*<!ENTITY[[:space:]]+version[[:space:]]+"[^"]*"|<!ENTITY version "$VERSION"|
s|^\s*<!ENTITY[[:space:]]+packageVER[[:space:]]+"[^"]*"|<!ENTITY packageVER "$VERSION"|
s|^\s*<!ENTITY[[:space:]]+pkgBUILD[[:space:]]+"[^"]*"|<!ENTITY pkgBUILD "$BUILD_NUM"|
s|^\s*<!ENTITY[[:space:]]+packageName[[:space:]]+"[^"]*"|<!ENTITY packageName "$PACKAGE_BASENAME"|
s|^\s*<!ENTITY[[:space:]]+packagefile[[:space:]]+"[^"]*"|<!ENTITY packagefile "$PACKAGE_NAME"|
s|^\s*<!ENTITY[[:space:]]+packageURL[[:space:]]+"[^"]*"|<!ENTITY packageURL "file:///tmp/$PACKAGE_NAME"|
s|^\s*<FILE[[:space:]]+Name=['"]?[^'">]+['"]?[[:space:]]+Run=['"]upgradepkg[^'"]*['"]>|<FILE Name='/tmp/$PACKAGE_NAME' Run='upgradepkg --install-new'>|
/upgradepkg/,/<\/FILE>/{ s|^\s*<URL>.*</URL>|<URL>file:///tmp/$PACKAGE_NAME</URL>| }
SEDEOF
sed -E -f "$SED_SCRIPT" "$PLG_FILE" > "$TEMP_PLG"
rm -f "$SED_SCRIPT"

echo "Generated temporary plugin manifest: $TEMP_PLG"

PKG_VERSION="$VERSION" PKG_BUILD="$BUILD_NUM" OUTPUT_FOLDER="$OUTPUT_PATH" bash "$SCRIPT_DIR/build_in_docker.sh"

PACKAGE_PATH="$OUTPUT_PATH/$PACKAGE_NAME"
if [[ ! -f "$PACKAGE_PATH" ]]; then
  echo "Build completed but package not found: $PACKAGE_PATH"
  exit 1
fi

MD5=$(md5sum "$PACKAGE_PATH" | awk '{print $1}')
sed -i -E "s|^\s*<!ENTITY[[:space:]]+packageMD5[[:space:]]+\"[^\"]*\"|<!ENTITY packageMD5  \"$MD5\"|" "$TEMP_PLG"
sed -i -E "s|^\s*<MD5>.*</MD5>|<MD5>$MD5</MD5>|" "$TEMP_PLG"

echo "Build successful"
echo "  Package: $PACKAGE_PATH"
echo "  MD5: $MD5"
