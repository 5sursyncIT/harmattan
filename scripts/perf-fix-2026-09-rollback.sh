#!/usr/bin/env bash
# Rollback de scripts/perf-fix-2026-09.sh.
#
# Restaure les fichiers depuis les .bak.<horodatage> listés dans le manifeste
# écrit par le script d'application, et rejoue le SQL de rollback des constantes.
#
# Usage : sudo bash scripts/perf-fix-2026-09-rollback.sh [horodatage]
#         (sans argument : reprend le manifeste le plus récent)
set -euo pipefail

APP_DIR="/var/www/html/senharmattan-shop"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Ce script doit être lancé avec sudo."
  exit 1
fi

if [ $# -ge 1 ]; then
  MANIFEST="/var/lib/senharmattan-perf-fix-$1.manifest"
else
  MANIFEST="$(ls -t /var/lib/senharmattan-perf-fix-*.manifest 2>/dev/null | head -1 || true)"
fi

if [ -z "${MANIFEST:-}" ] || [ ! -f "$MANIFEST" ]; then
  echo "✗ Aucun manifeste trouvé dans /var/lib/senharmattan-perf-fix-*.manifest"
  exit 1
fi
echo "→ Manifeste : $MANIFEST"

echo "═══ Restauration des fichiers ═══"
while read -r bak; do
  case "$bak" in
    *.const-rollback.sql) continue ;;
  esac
  [ -f "$bak" ] || { echo "  · introuvable : $bak"; continue; }
  orig="${bak%.bak.*}"
  cp -p "$bak" "$orig"
  echo "  ✓ $orig"
done < "$MANIFEST"

echo "═══ Restauration des constantes Dolibarr ═══"
SQL="$(grep -m1 'const-rollback.sql' "$MANIFEST" || true)"
if [ -n "$SQL" ] && [ -f "$SQL" ]; then
  MYSQL_PASS="$(grep -m1 -E '^MYSQL_PASSWORD=|^MYSQL_PASS=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
  MYSQL_USER="$(grep -m1 '^MYSQL_USER=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
  MYSQL_DB="$(grep -m1 '^MYSQL_DATABASE=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
  MYSQL_PWD="$MYSQL_PASS" mysql -u "$MYSQL_USER" -h 127.0.0.1 "$MYSQL_DB" < "$SQL"
  echo "  ✓ constantes restaurées depuis $SQL"
  echo "  · l'index idx_facture_pos_source est conservé (sans effet de bord ;"
  echo "    pour l'ôter : DROP INDEX idx_facture_pos_source ON llx_facture;)"
else
  echo "  · pas de SQL de rollback dans le manifeste"
fi

echo "═══ Réglages système ═══"
rm -f /etc/sysctl.d/99-senharmattan-perf.conf /etc/modules-load.d/bbr.conf
sysctl -w net.ipv4.tcp_slow_start_after_idle=1 >/dev/null
a2disconf zzz-senharmattan-perf >/dev/null 2>&1 || true

apache2ctl configtest
systemctl reload apache2
systemctl restart senharmattan-shop
echo "✓ Rollback effectué."
