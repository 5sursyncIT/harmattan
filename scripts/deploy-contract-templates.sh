#!/usr/bin/env bash
# Déploie les templates ODT de contrats générés vers Dolibarr.
# Sauvegarde d'abord les templates existants (horodatés), puis copie les neufs.
#
# Usage : sudo bash scripts/deploy-contract-templates.sh
#
# Pré-requis : avoir lancé au préalable
#   node scripts/build-contract-templates.mjs
set -euo pipefail

SRC="/tmp/contract-templates-v2"
DEST="/var/www/html/dolibarr/documents/doctemplates/contracts"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ ! -d "$SRC" ]; then
  echo "✗ $SRC introuvable — lancez d'abord : node scripts/build-contract-templates.mjs"
  exit 1
fi

echo "→ Sauvegarde des templates existants (suffixe .bak.$STAMP)…"
for f in "$DEST"/template_*.odt; do
  [ -e "$f" ] || continue
  case "$f" in *.bak.*) continue;; esac
  cp -p "$f" "$f.bak.$STAMP"
done

echo "→ Copie des nouveaux templates…"
cp "$SRC"/*.odt "$DEST"/

echo "→ Droits www-data…"
chown www-data:www-data "$DEST"/template_*.odt
chmod 644 "$DEST"/template_*.odt

echo "✓ Déploiement terminé. Templates actifs dans $DEST"
echo "  (Sauvegardes : $DEST/template_*.odt.bak.$STAMP)"
