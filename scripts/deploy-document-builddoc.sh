#!/usr/bin/env bash
# Déploie document-builddoc.php dans le module custom Dolibarr.
#
# Le helper génère les PDF de factures client, devis et factures fournisseur
# (l'API REST /builddoc renvoie 404 en v21). Il est appelé par le backend Node
# et s'authentifie par secret partagé (.webhook-secret), pas par DOLAPIKEY.
#
# Usage : sudo ./scripts/deploy-document-builddoc.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/document-builddoc.php"
DEST_DIR="/var/www/html/dolibarr/htdocs/custom/senharmattansync"
DEST="$DEST_DIR/document-builddoc.php"

[[ -f "$SRC" ]] || { echo "Source introuvable : $SRC" >&2; exit 1; }
[[ -d "$DEST_DIR" ]] || { echo "Dossier cible introuvable : $DEST_DIR" >&2; exit 1; }

php -l "$SRC" >/dev/null || { echo "Erreur de syntaxe PHP — déploiement annulé" >&2; exit 1; }

if [[ -f "$DEST" ]]; then
  BACKUP="$DEST.bak.$(date +%Y%m%d_%H%M%S)"
  cp -p "$DEST" "$BACKUP"
  echo "Sauvegarde : $BACKUP"
fi

install -o www-data -g www-data -m 644 "$SRC" "$DEST"
echo "Déployé : $DEST"
