#!/usr/bin/env bash
# Télécharge les fichiers ffmpeg.wasm AU MOMENT DU BUILD (sur les serveurs Vercel)
# et les place en same-origin dans dist/vendor. Aucun upload manuel requis.
set -euo pipefail

echo "▶ Build : préparation de dist/"
rm -rf dist
mkdir -p dist/vendor
cp index.html app.js turbo.js style.css manifest.webmanifest sw.js dist/
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

# --- Moteur turbo (WebCodecs) : demultiplexeur + multiplexeur MP4 ---
# On resout la derniere version publiee : evite qu'un numero fige casse le build.
fetch_latest() {
  local name="$1" dest="$2" sub="$3"
  local url; url="$(curl -fsSL "https://registry.npmjs.org/${name}/latest" \
    | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p')"
  local tmp; tmp="$(mktemp -d)"
  echo "  ↓ ${name}@latest"
  curl -fsSL "$url" -o "$tmp/p.tgz"
  tar -xzf "$tmp/p.tgz" -C "$tmp"
  mkdir -p "$dest"
  cp -R "$tmp/package/${sub}/." "$dest/"
  rm -rf "$tmp"
}

fetch_latest "mp4box"    "dist/vendor/mp4box"    "dist"
fetch_latest "mp4-muxer" "dist/vendor/mp4-muxer" "build"

# Verification : les deux fichiers cles doivent exister, sinon le build echoue.
test -f dist/vendor/mp4box/mp4box.all.js    || { echo "✖ mp4box.all.js manquant";    exit 1; }
test -f dist/vendor/mp4-muxer/mp4-muxer.mjs || { echo "✖ mp4-muxer.mjs manquant";    exit 1; }

echo "▶ Contenu de dist/vendor :"
find dist/vendor -maxdepth 2 -type f | sort
echo "✅ Build terminé."
