#!/usr/bin/env bash
# Déploie scripts/contract-builddoc.php (source canonique du dépôt) vers le
# module custom Dolibarr. Sauvegarde horodatée de la version en place.
#
# Usage : sudo bash scripts/deploy-contract-builddoc.sh
set -euo pipefail

SRC="$(dirname "$0")/contract-builddoc.php"
DEST="/var/www/html/dolibarr/htdocs/custom/senharmattansync/contract-builddoc.php"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ ! -f "$SRC" ]; then
  echo "✗ $SRC introuvable"
  exit 1
fi

php -l "$SRC" >/dev/null || { echo "✗ Erreur de syntaxe PHP — déploiement annulé"; exit 1; }

if [ -f "$DEST" ]; then
  echo "→ Sauvegarde de la version en place (.bak.$STAMP)…"
  cp -p "$DEST" "$DEST.bak.$STAMP"
fi

echo "→ Copie…"
cp "$SRC" "$DEST"
chown www-data:www-data "$DEST"
chmod 644 "$DEST"

echo "✓ Déployé : $DEST"
