#!/usr/bin/env bash
# Télécharge les dépendances AU MOMENT DU BUILD (sur les serveurs Vercel) et les
# place en same-origin dans dist/vendor. Aucun upload manuel, aucun npm install.
#
# Les versions ET les empreintes viennent de vendor.lock : le build est
# reproductible, et un tarball modifié en amont fait échouer le build au lieu
# d'être servi aux utilisateurs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$ROOT/vendor.lock"

echo "▶ Build : préparation de dist/"
rm -rf dist
mkdir -p dist/vendor
cp index.html splitter.html echo.html studio.html lyrics.html \
   app.js turbo.js silence.js media.js sfx.js \
   echo.js echo-worker.js studio.js lyrics.js sw-register.js \
   style.css manifest.webmanifest sw.js dist/
cp -R icons dist/icons

# ---------------------------------------------------------------------------
# vendor.lock : <paquet> <version> <integrity>
# ---------------------------------------------------------------------------
lock_field() {  # <paquet> <colonne 2|3>
  awk -v pkg="$1" -v col="$2" '$1 == pkg { print $col; found=1 } END { exit !found }' "$LOCK"
}

# Vérifie qu'un tarball correspond à l'empreinte sha512 publiée par npm.
verify_integrity() {  # <fichier> <integrity "sha512-<base64>">
  local file="$1" want="$2" got
  case "$want" in
    sha512-*) ;;
    *) echo "  ✖ empreinte illisible dans vendor.lock : $want"; return 1 ;;
  esac
  got="sha512-$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)"
  if [ "$got" != "$want" ]; then
    echo "  ✖ EMPREINTE INVALIDE"
    echo "     attendue : $want"
    echo "     obtenue  : $got"
    return 1
  fi
}

# Télécharge et vérifie un tarball npm ; laisse son contenu extrait dans $EXTRACTED.
EXTRACTED=""
fetch_tarball() {  # <paquet>
  local name="$1" ver integrity short url tmp
  ver="$(lock_field "$name" 2)" || { echo "  ✖ $name absent de vendor.lock"; return 1; }
  integrity="$(lock_field "$name" 3)"
  short="${name##*/}"                       # @ffmpeg/ffmpeg -> ffmpeg
  url="https://registry.npmjs.org/${name}/-/${short}-${ver}.tgz"

  tmp="$(mktemp -d)"
  echo "  ↓ ${name}@${ver}"
  curl -fsSL "$url" -o "$tmp/p.tgz"
  verify_integrity "$tmp/p.tgz" "$integrity" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/p.tgz" -C "$tmp"
  EXTRACTED="$tmp"
}

# Copie un sous-dossier entier du paquet (moteur ffmpeg).
fetch_pkg() {  # <paquet> <dossier-cible> <sous-dossier-dans-le-paquet>
  local name="$1" dest="$2" sub="$3"
  fetch_tarball "$name"
  mkdir -p "$dest"
  cp -R "$EXTRACTED/package/${sub}/." "$dest/"
  rm -rf "$EXTRACTED"
}

# Copie UN fichier, cherché n'importe où dans le paquet (arborescences variables).
fetch_file() {  # <paquet> <fichier-recherche> <dossier-cible>
  local name="$1" want="$2" dest="$3" found
  fetch_tarball "$name"
  found="$(find "$EXTRACTED/package" -type f -name "$want" | head -1)"
  if [ -z "$found" ]; then
    echo "  ✖ ${want} absent de ${name}. Fichiers livrés :"
    find "$EXTRACTED/package" -type f \( -name '*.js' -o -name '*.mjs' \) \
      | sed "s|$EXTRACTED/package|     .|" | head -20
    rm -rf "$EXTRACTED"; return 1
  fi
  mkdir -p "$dest"
  cp "$found" "$dest/"
  echo "  ✔ ${name} -> ${dest}/$(basename "$found")"
  rm -rf "$EXTRACTED"
}

echo "▶ Moteur ffmpeg (mode compatible)"
fetch_pkg "@ffmpeg/ffmpeg"  "dist/vendor/ffmpeg"  "dist/esm"
fetch_pkg "@ffmpeg/util"    "dist/vendor/util"    "dist/esm"
fetch_pkg "@ffmpeg/core"    "dist/vendor/core-st" "dist/esm"   # mono-thread
fetch_pkg "@ffmpeg/core-mt" "dist/vendor/core-mt" "dist/esm"   # multi-thread

echo "▶ Moteur turbo : mp4box (démultiplexage) + mp4-muxer (multiplexage)"
fetch_file "mp4box"    "mp4box.all.js"  "dist/vendor/mp4box"
fetch_file "mp4-muxer" "mp4-muxer.mjs"  "dist/vendor/mp4-muxer"

# ---------------------------------------------------------------------------
# Garde-fou : le build doit échouer BRUYAMMENT plutôt que livrer une app
# amputée d'un de ses deux moteurs.
# ---------------------------------------------------------------------------
echo "▶ Vérification de dist/"
REQUIRED=(
  "dist/index.html"
  "dist/app.js"
  "dist/turbo.js"
  "dist/silence.js"
  "dist/echo-worker.js"
  "dist/sw-register.js"
  "dist/sw.js"
  "dist/vendor/ffmpeg/index.js"
  "dist/vendor/util/index.js"
  "dist/vendor/core-st/ffmpeg-core.wasm"
  "dist/vendor/core-mt/ffmpeg-core.wasm"
  "dist/vendor/mp4box/mp4box.all.js"
  "dist/vendor/mp4-muxer/mp4-muxer.mjs"
)
missing=0
for f in "${REQUIRED[@]}"; do
  [ -f "$f" ] || { echo "  ✖ manquant : $f"; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "✖ Build incomplet."; exit 1; }

find dist/vendor -maxdepth 2 -type f | sort
echo "✅ Build terminé."
