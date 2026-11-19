#!/usr/bin/env bash
# Publie l'état actuel d'Essaim dans un repo public, en un seul commit, sans l'historique du repo de travail
# (ses commits, issues et PR peuvent parler de ton installation ; le code, lui, n'en contient rien).
#
#   scripts/publish-public.sh <propriétaire/repo> [référence=origin/HEAD] [--create] [--dry-run]
#
# - Prend l'arbre de la référence (git archive : seuls les fichiers suivis, donc ni wrangler.jsonc ni .dev.vars).
# - Refuse de publier si un fichier contient un des motifs de ~/.essaim/publish-guard.txt (un par ligne, sans
#   distinction de casse ; lignes vides et # ignorées) : ton domaine, ton compte, tes noms de projets…
# - Pousse sur la branche par défaut du repo public un commit « Essaim <date> (<sha>) » qui remplace tout son contenu.
# - --create : crée le repo public s'il n'existe pas (gh repo create --public).
# - --dry-run : s'arrête après le garde-fou (rien n'est poussé).
set -euo pipefail

TARGET="${1:-}"
REF="origin/HEAD"
CREATE=0
DRY=0
for arg in "${@:2}"; do
  case "$arg" in
    --create) CREATE=1 ;;
    --dry-run) DRY=1 ;;
    *) REF="$arg" ;;
  esac
done
if [[ ! "$TARGET" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Usage : scripts/publish-public.sh <propriétaire/repo> [référence=origin/HEAD] [--create] [--dry-run]" >&2
  exit 1
fi

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
git fetch -q origin
SHA="$(git rev-parse --short "$REF")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. L'arbre à publier.
mkdir "$WORK/tree"
git archive "$REF" | tar -x -C "$WORK/tree"

# 2. Garde-fou : rien de ton installation.
GUARD="${PUBLISH_GUARD:-$HOME/.essaim/publish-guard.txt}"
if [[ -f "$GUARD" ]]; then
  PATTERNS="$WORK/patterns"
  grep -v '^[[:space:]]*#' "$GUARD" | grep -v '^[[:space:]]*$' > "$PATTERNS" || true
  if [[ -s "$PATTERNS" ]] && grep -rniIF -f "$PATTERNS" "$WORK/tree" > "$WORK/hits"; then
    echo "Publication refusée : ces lignes contiennent un motif de $GUARD :" >&2
    sed "s#^$WORK/tree/##" "$WORK/hits" | head -40 >&2
    exit 1
  fi
else
  echo "Attention : pas de garde-fou ($GUARD). Mets-y ton domaine, ton compte, tes projets, un par ligne." >&2
fi

if [[ "$DRY" == 1 ]]; then
  echo "✓ $(find "$WORK/tree" -type f | wc -l | tr -d ' ') fichiers prêts à publier ($SHA), garde-fou passé. Rien n'est poussé (--dry-run)."
  exit 0
fi

# 3. Le repo public.
if ! gh repo view "$TARGET" --json name >/dev/null 2>&1; then
  if [[ "$CREATE" != 1 ]]; then
    echo "Le repo $TARGET n'existe pas (relance avec --create pour le créer, public)." >&2
    exit 1
  fi
  gh repo create "$TARGET" --public --description "Des agents Claude Code qui traitent tes tickets GitHub en autonomie, pilotés depuis Cloudflare."
fi
BRANCH="$(gh repo view "$TARGET" --json defaultBranchRef --jq '.defaultBranchRef.name // ""')"
BRANCH="${BRANCH:-main}"
git clone -q "https://github.com/$TARGET.git" "$WORK/public" 2>/dev/null || git init -q "$WORK/public"
cd "$WORK/public"
git checkout -q -B "$BRANCH" "origin/$BRANCH" 2>/dev/null || git checkout -q -B "$BRANCH"
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$TARGET.git"

# 4. Remplacer tout le contenu, committer, pousser.
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$WORK/tree/." .
git add -A
if git diff --cached --quiet; then
  echo "Rien de nouveau à publier ($SHA)."
  exit 0
fi
git commit -q -m "Essaim $(date +%Y-%m-%d) ($SHA)"
git push -q origin "$BRANCH"
echo "✓ Publié sur https://github.com/$TARGET ($SHA)"
