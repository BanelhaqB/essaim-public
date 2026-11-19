#!/usr/bin/env bash
# Installe le runner sur le Mac comme agent launchd : il démarre à l'ouverture de session, redémarre s'il s'arrête,
# et empêche la mise en veille système tant qu'il tourne (caffeinate -s : sur secteur seulement).
# Usage : ./install-mac.sh            (installe ou met à jour, puis redémarre)
#         ./install-mac.sh uninstall
set -euo pipefail

LABEL="com.essaim.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOME_DIR="$HOME/.essaim"
ENV_FILE="$HOME_DIR/runner.env"
SRC="$(cd "$(dirname "$0")" && pwd)/src/runner.mjs"
NODE="$(command -v node)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Runner désinstallé (l'état reste dans $HOME_DIR)."
  exit 0
fi

mkdir -p "$HOME_DIR/logs"
chmod 700 "$HOME_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  # L'adresse d'Essaim : le domaine de l'instance (~/.essaim/instance.json, voir web/scripts/configure.mjs) s'il existe.
  DOMAIN=""
  INSTANCE="${ESSAIM_INSTANCE:-$HOME_DIR/instance.json}"
  if [[ -f "$INSTANCE" ]]; then
    DOMAIN="$("$NODE" -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).domain ?? "") } catch {}' "$INSTANCE")"
  fi
  cat > "$ENV_FILE" <<EOF
# Runner d’Essaim (voir README.md). Fichier lu par node --env-file.
CONTROL_URL=https://${DOMAIN:-essaim.exemple.fr}
RUNNER_TOKEN=$(openssl rand -hex 32)
MACHINE=mac
CAPACITY=2
# Jeton de service Cloudflare Access, si /api/runner n'est pas en Bypass :
# CF_ACCESS_CLIENT_ID=
# CF_ACCESS_CLIENT_SECRET=
EOF
  chmod 600 "$ENV_FILE"
  echo "Créé $ENV_FILE : vérifie CONTROL_URL, et pose le même RUNNER_TOKEN dans le Worker :"
  echo "  grep '^RUNNER_TOKEN=' $ENV_FILE | cut -d= -f2 | (cd $(dirname "$SRC")/../../web && npx wrangler secret put RUNNER_TOKEN)"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>--env-file=$ENV_FILE</string><string>$SRC</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>fr_FR.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/runner.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/runner.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Runner lancé. Journal : tail -f $HOME_DIR/logs/runner.log"
