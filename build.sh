#!/usr/bin/env bash
# Télécharge les fichiers ffmpeg.wasm AU MOMENT DU BUILD (sur les serveurs Vercel)
# et les place en same-origin dans dist/vendor. Aucun upload manuel requis.
set -euo pipefail

echo "▶ Build : préparation de dist/"
rm -rf dist
mkdir -p dist/vendor
cp index.html app.js style.css manifest.webmanifest sw.js dist/
cp -R icons dist/icons

# fetch_pkg <nom-npm> <version> <dossier-cible> <sous-dossier-dans-le-paquet>
fetch_pkg() {
  local name="$1" ver="$2" dest="$3" sub="$4"
  local short="${name##*/}"                 # @ffmpeg/ffmpeg -> ffmpeg
  local url="https://registry.npmjs.org/${name}/-/${short}-${ver}.tgz"
  local tmp; tmp="$(mktemp -d)"
  echo "  ↓ ${name}@${ver}"
  curl -fsSL "$url" -o "$tmp/p.tgz"
  tar -xzf "$tmp/p.tgz" -C "$tmp"
  mkdir -p "$dest"
  cp -R "$tmp/package/${sub}/." "$dest/"
  rm -rf "$tmp"
}

fetch_pkg "@ffmpeg/ffmpeg"  "0.12.10" "dist/vendor/ffmpeg"  "dist/esm"
fetch_pkg "@ffmpeg/util"    "0.12.1"  "dist/vendor/util"    "dist/esm"
fetch_pkg "@ffmpeg/core"    "0.12.6"  "dist/vendor/core-st" "dist/esm"   # mono-thread
fetch_pkg "@ffmpeg/core-mt" "0.12.6"  "dist/vendor/core-mt" "dist/esm"   # multi-thread

echo "▶ Contenu de dist/vendor :"
find dist/vendor -maxdepth 2 -type f | sort
echo "✅ Build terminé."
