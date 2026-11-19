#!/usr/bin/env bash
# Installe le veilleur des services d'Essaim sur la machine Linux qui les héberge (un serveur, un conteneur…),
# comme service systemd `essaim-services` (root : il pilote systemctl et pose les drop-ins de pause).
# Usage, en root, depuis ce dossier runner/ copié sur la machine :
#   ./install-services.sh [services.json]   (installe ou met à jour, puis redémarre ; le fichier donné devient
#                                            la liste des services de la machine, /etc/essaim-services.json)
#   ./install-services.sh uninstall         (retire le veilleur ; les pauses en cours restent appliquées)
set -euo pipefail

DEST=/opt/essaim-services
ENV_FILE=/etc/essaim-services.env
CONFIG=/etc/essaim-services.json
UNIT=/etc/systemd/system/essaim-services.service
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "uninstall" ]]; then
  systemctl disable --now essaim-services 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "Veilleur retiré ($DEST et $ENV_FILE restent en place)."
  exit 0
fi

command -v node >/dev/null || { echo "Node 24 est requis."; exit 1; }
mkdir -p "$DEST/src"
cp "$HERE/package.json" "$DEST/"
cp "$HERE/src/control.mjs" "$HERE/src/services.mjs" "$HERE/src/services-main.mjs" "$DEST/src/"
# La liste des services de la machine (SERVICES_CONFIG peut pointer vers un autre fichier).
if [[ -n "${1:-}" ]]; then
  install -m 0644 "$1" "$CONFIG"
elif [[ ! -f "$CONFIG" ]]; then
  install -m 0644 "$HERE/services.example.json" "$CONFIG"
  echo "Créé $CONFIG depuis l'exemple : décris-y les services de cette machine (README, « Services d'un serveur »)."
fi

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
# Veilleur des services d'Essaim (README.md). RUNNER_TOKEN : le même que le Worker et le runner du Mac.
CONTROL_URL=https://essaim.exemple.fr
RUNNER_TOKEN=
# Nom de la machine dans Essaim (« nuc » : la machine serveur de l'interface).
MACHINE=nuc
# SERVICES_CONFIG=$CONFIG
ENV
  echo "Créé $ENV_FILE : renseigne CONTROL_URL et RUNNER_TOKEN, puis relance ce script."
  exit 0
fi

cat > "$UNIT" <<UNIT
# Veilleur des services d'Essaim : état des services de la machine, pause décidée dans Essaim.
[Unit]
Description=Essaim : veilleur des services
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $DEST/src/services-main.mjs
Restart=always
RestartSec=10
SyslogIdentifier=essaim-services

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable essaim-services >/dev/null
systemctl restart essaim-services
echo "Veilleur installé : journalctl -u essaim-services -f"
