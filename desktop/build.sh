#!/bin/bash
# Fabrique Essaim.app (app macOS autour de l'interface web) sans Xcode.
#   ./build.sh            → desktop/build/Essaim.app
#   ./build.sh install    → et la copie dans /Applications (ou ~/Applications), puis la lance
# Adresse inscrite dans l'app : ESSAIM_URL=https://… ./build.sh, sinon le domaine de ~/.essaim/instance.json
# (web/scripts/configure.mjs) ; sans l'une ni l'autre, l'app la demande au premier lancement.
set -euo pipefail
cd "$(dirname "$0")"

OUT=build
APP="$OUT/Essaim.app"
rm -rf "$APP"
# fr.lproj : messages du système (erreurs réseau, boîtes de dialogue) en français.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/fr.lproj"

# Binaire universel (Apple Silicon + Intel), macOS 14 au moins.
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.0" -o "$OUT/Essaim-$arch" Essaim.swift
done
lipo -create -output "$APP/Contents/MacOS/Essaim" "$OUT/Essaim-arm64" "$OUT/Essaim-x86_64"
rm "$OUT"/Essaim-arm64 "$OUT"/Essaim-x86_64

# Icône : même logo que le site.
rm -rf "$OUT/AppIcon.iconset"
swift icon.swift ../web/public/icon.svg "$OUT/AppIcon.iconset"
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$OUT/AppIcon.iconset"
rm -rf "$OUT/AppIcon.iconset"

# Numéro de build = nombre de commits (croît à chaque version).
VERSION=$(git rev-list --count HEAD 2>/dev/null || echo 1)
URL="${ESSAIM_URL:-}"
INSTANCE="${ESSAIM_INSTANCE:-$HOME/.essaim/instance.json}"
if [[ -z "$URL" && -f "$INSTANCE" ]] && command -v node >/dev/null; then
  DOMAIN="$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).domain ?? "") } catch {}' "$INSTANCE")"
  [[ -n "$DOMAIN" ]] && URL="https://$DOMAIN/"
fi
sed -e "s/__VERSION__/$VERSION/" -e "s#__URL__#$URL#" Info.plist > "$APP/Contents/Info.plist"

# Signature locale (ad hoc) : suffit pour l'ouvrir sur ce Mac ; l'app n'est pas distribuée.
codesign --force --sign - --timestamp=none "$APP"
echo "✓ $APP (build $VERSION, ${URL:-adresse demandée au lancement})"

if [[ "${1:-}" == "install" ]]; then
  DEST=/Applications
  [[ -w "$DEST" ]] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  # Ferme l'ancienne version si elle tourne, puis remplace-la.
  if pgrep -x Essaim >/dev/null; then osascript -e 'tell application "Essaim" to quit' >/dev/null 2>&1 || true; fi
  rm -rf "$DEST/Essaim.app"
  ditto "$APP" "$DEST/Essaim.app"
  echo "✓ installée dans $DEST/Essaim.app"
  open "$DEST/Essaim.app"
fi
