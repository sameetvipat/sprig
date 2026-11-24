#!/bin/sh
# Packages the extension as dist/sprig-mindful-pet-<version>.vsix (no vsce or network needed).
set -e
cd "$(dirname "$0")"
V=$(node -p "require('./package.json').version")
T=$(mktemp -d)
mkdir -p "$T/extension/media" "$T/extension/docs/screenshots" dist
cp package.json extension.js "$T/extension/"
cp LICENSE "$T/extension/LICENSE.txt"
cp NOTICE "$T/extension/NOTICE.txt"
cp README.md "$T/extension/readme.md"
cp docs/screenshots/*.png "$T/extension/docs/screenshots/"
cp media/pet.html "$T/extension/media/"
cp "packaging/[Content_Types].xml" "$T/"
sed -E "s/(Identity [^>]*Version=\")[^\"]+/\1$V/" packaging/extension.vsixmanifest > "$T/extension.vsixmanifest"
OUT="$PWD/dist/sprig-mindful-pet-$V.vsix"
rm -f "$OUT"
(cd "$T" && zip -qX "$OUT" '[Content_Types].xml' extension.vsixmanifest extension/package.json extension/extension.js extension/readme.md extension/LICENSE.txt extension/NOTICE.txt extension/media/pet.html extension/docs/screenshots/*.png)
rm -rf "$T"
cp "$OUT" dist/sprig.vsix # stable name for the README download button
echo "$OUT"
