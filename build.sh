#!/usr/bin/env bash
# Télécharge les fichiers ffmpeg.wasm AU MOMENT DU BUILD (sur les serveurs Vercel)
# et les place en same-origin dans dist/vendor. Aucun upload manuel requis.
set -euo pipefail

echo "▶ Build : préparation de dist/"
rm -rf dist
mkdir -p dist/vendor
cp index.html splitter.html echo.html studio.html lyrics.html \
   app.js turbo.js media.js sfx.js echo.js studio.js lyrics.js \
   style.css manifest.webmanifest sw.js dist/
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

# --- Moteur turbo (WebCodecs) : demultiplexeur + multiplexeur MP4 ---------
# On ne devine PAS l'arborescence du paquet : on cherche le fichier voulu
# n'importe ou dedans. Si la derniere version ne convient pas, on retombe sur
# une version epinglee connue. En cas d'echec, on affiche ce que contient le
# paquet pour qu'on sache quoi corriger.

npm_tarball() {   # <nom> <version|latest>
  curl -fsSL "https://registry.npmjs.org/$1/$2" \
    | tr ',' '\n' \
    | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p' \
    | head -1
}

fetch_file() {    # <nom> <version|latest> <fichier-recherche> <dossier-cible>
  local name="$1" ver="$2" want="$3" dest="$4"
  local url tmp found

  url="$(npm_tarball "$name" "$ver" || true)"
  if [ -z "$url" ]; then
    echo "  ✖ ${name}@${ver} : introuvable sur le registre npm"
    return 1
  fi

  tmp="$(mktemp -d)"
  if ! curl -fsSL "$url" -o "$tmp/p.tgz" || ! tar -xzf "$tmp/p.tgz" -C "$tmp"; then
    echo "  ✖ ${name}@${ver} : telechargement ou extraction impossible"
    rm -rf "$tmp"; return 1
  fi

  found="$(find "$tmp/package" -type f -name "$want" | head -1)"
  if [ -z "$found" ]; then
    echo "  ✖ ${want} absent de ${name}@${ver}. Fichiers livres :"
    find "$tmp/package" -type f \( -name '*.js' -o -name '*.mjs' \) \
      | sed "s|$tmp/package|     .|" | head -20
    rm -rf "$tmp"; return 1
  fi

  mkdir -p "$dest"
  cp "$found" "$dest/"
  echo "  ✔ ${name}@${ver} -> ${dest}/$(basename "$found")"
  rm -rf "$tmp"
}

echo "▶ Moteur turbo : mp4box + mp4-muxer"

fetch_file "mp4box" "latest" "mp4box.all.js" "dist/vendor/mp4box" \
  || fetch_file "mp4box" "0.5.2" "mp4box.all.js" "dist/vendor/mp4box" \
  || { echo "✖ Impossible de recuperer mp4box. Le moteur turbo ne peut pas etre construit."; exit 1; }

fetch_file "mp4-muxer" "latest" "mp4-muxer.mjs" "dist/vendor/mp4-muxer" \
  || fetch_file "mp4-muxer" "5.1.5" "mp4-muxer.mjs" "dist/vendor/mp4-muxer" \
  || fetch_file "mp4-muxer" "4.4.2" "mp4-muxer.mjs" "dist/vendor/mp4-muxer" \
  || { echo "✖ Impossible de recuperer mp4-muxer. Le moteur turbo ne peut pas etre construit."; exit 1; }

echo "▶ Contenu de dist/vendor :"
find dist/vendor -maxdepth 2 -type f | sort
echo "✅ Build terminé."
