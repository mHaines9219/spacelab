#!/usr/bin/env bash
# Fetch the CC0 floor + wall textures from ambientCG into public/assets/textures/.
# Idempotent: skips any set already present. Binaries stay out of git (see PLAN.md's
# "swap for a fetch script before the catalog grows"). Provenance is in the assets README.
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="public/assets/textures"

# local-name  ambientCG-id
SETS=(
  "wood-light WoodFloor051"
  "wood-dark  WoodFloor043"
  "tile       Tiles141"
  "concrete   Concrete034"
  "drywall    PaintedPlaster017"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for entry in "${SETS[@]}"; do
  read -r name id <<<"$entry"
  out="$DEST/$name"
  if [[ -f "$out/color.jpg" ]]; then
    echo "✓ $name ($id) already present"
    continue
  fi
  echo "↓ $name ($id)…"
  mkdir -p "$out"
  # -L is required: get?file= 302-redirects to a tokenised CDN URL.
  curl -fsSL -A "Mozilla/5.0" -o "$tmp/$id.zip" \
    "https://ambientcg.com/get?file=${id}_1K-JPG.zip"
  unzip -oq "$tmp/$id.zip" -d "$tmp/$id"
  cp "$tmp/$id/${id}_1K-JPG_Color.jpg"    "$out/color.jpg"
  cp "$tmp/$id/${id}_1K-JPG_NormalGL.jpg" "$out/normal.jpg"
  cp "$tmp/$id/${id}_1K-JPG_Roughness.jpg" "$out/roughness.jpg"
done

echo "Textures ready in $DEST"
