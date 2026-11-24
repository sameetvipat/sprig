#!/bin/sh
# Packages the extension as dist/sprig.vsix (no vsce or network needed).
set -e
cd "$(dirname "$0")"
V=$(node -p "require('./package.json').version")
T=$(mktemp -d)
mkdir -p "$T/extension/media" dist
cp package.json extension.js updater.js icon.png "$T/extension/"
cp LICENSE "$T/extension/LICENSE.txt"
cp NOTICE "$T/extension/NOTICE.txt"
cp README.md "$T/extension/readme.md"
cp media/pet.html "$T/extension/media/"
cp "packaging/[Content_Types].xml" "$T/"
sed -E "s/(Identity [^>]*Version=\")[^\"]+/\1$V/" packaging/extension.vsixmanifest > "$T/extension.vsixmanifest"
OUT="$PWD/dist/sprig.vsix"
rm -f "$OUT"
(cd "$T" && zip -qX "$OUT" '[Content_Types].xml' extension.vsixmanifest extension/package.json extension/extension.js extension/updater.js extension/icon.png extension/readme.md extension/LICENSE.txt extension/NOTICE.txt extension/media/pet.html)
rm -rf "$T"
echo "$OUT"
