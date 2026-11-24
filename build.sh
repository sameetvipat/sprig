#!/bin/sh
# Packages the extension as dist/sprig-mindful-pet-<version>.vsix (no vsce or network needed).
set -e
cd "$(dirname "$0")"
V=$(node -p "require('./package.json').version")
T=$(mktemp -d)
mkdir -p "$T/extension/media" dist
cp package.json extension.js readme.md LICENSE.txt "$T/extension/"
cp media/pet.html "$T/extension/media/"
cp "packaging/[Content_Types].xml" "$T/"
sed -E "s/(Identity [^>]*Version=\")[^\"]+/\1$V/" packaging/extension.vsixmanifest > "$T/extension.vsixmanifest"
OUT="$PWD/dist/sprig-mindful-pet-$V.vsix"
rm -f "$OUT"
(cd "$T" && zip -qX "$OUT" '[Content_Types].xml' extension.vsixmanifest extension/package.json extension/extension.js extension/readme.md extension/LICENSE.txt extension/media/pet.html)
rm -rf "$T"
echo "$OUT"
