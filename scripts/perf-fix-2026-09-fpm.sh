#!/usr/bin/env bash
# Correctifs consécutifs à la bascule mpm_event + PHP-FPM (2026-09-01).
#
# 1. DIMENSIONNEMENT DU POOL PHP-FPM — le paquet Ubuntu livre pm.max_children=5.
#    Sous mpm_prefork + mod_php, Apache servait jusqu'à 150 requêtes PHP
#    simultanées (MaxRequestWorkers 150) ; depuis la bascule, PHP est plafonné à
#    5 et les requêtes s'empilent dans le backlog FPM. Régression mesurée sur
#    l'API Dolibarr : médiane 80 → 152 ms, p90 231 → 533 ms.
#    Dimensionnement retenu : worker mesuré à 40 Mo, 8,4 Go libres
#    → 30 workers ≈ 1,2 Go au pire, large marge.
#
# 2. RETRAIT DE SSLUseStapling — je l'avais ajouté à tort : les certificats
#    Let's Encrypt actuels (émetteur « YE1 ») ne portent plus d'URI OCSP,
#    l'agrafage n'a donc rien à agrafer. Directive morte, on la retire.
#
# Usage : sudo bash scripts/perf-fix-2026-09-fpm.sh
set -euo pipefail

PHPV="8.2"
POOL="/etc/php/$PHPV/fpm/pool.d/www.conf"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Ce script doit être lancé avec sudo."
  exit 1
fi

echo "═══ 1/3 · Dimensionnement du pool PHP-FPM ═══"
cp -p "$POOL" "$POOL.bak.$STAMP"
echo "  sauvegarde → $POOL.bak.$STAMP"

set_pool() {
  local key="$1" val="$2"
  # Remplace la directive qu'elle soit active ou commentée ; l'ajoute sinon.
  if grep -qE "^;?\s*$key\s*=" "$POOL"; then
    sed -i -E "s|^;?\s*$key\s*=.*|$key = $val|" "$POOL"
  else
    printf '%s = %s\n' "$key" "$val" >> "$POOL"
  fi
}

set_pool "pm"                       "dynamic"
set_pool "pm.max_children"          "30"
set_pool "pm.start_servers"         "8"
set_pool "pm.min_spare_servers"     "6"
set_pool "pm.max_spare_servers"     "12"
# Recycle les workers : borne les fuites mémoire des vieux modules Dolibarr.
set_pool "pm.max_requests"          "500"
# Filet de sécurité : aucun worker ne reste bloqué indéfiniment sur une requête
# (c'est ce que faisait max_execution_time=30 sous mod_php).
set_pool "request_terminate_timeout" "120"

grep -E "^(pm|pm\.[a-z_]+|request_terminate_timeout) *=" "$POOL" | sed 's/^/    /'

echo "═══ 2/3 · Retrait de l'agrafage OCSP (certificat sans URI OCSP) ═══"
for vhost in /etc/apache2/sites-available/senharmattan-le-ssl.conf \
             /etc/apache2/sites-available/erp-le-ssl.conf; do
  [ -f "$vhost" ] || continue
  if grep -q '^\s*SSLUseStapling on' "$vhost"; then
    cp -p "$vhost" "$vhost.bak.$STAMP"
    sed -i '/^\s*SSLUseStapling on\s*$/d' "$vhost"
    echo "  ✓ $(basename "$vhost") : SSLUseStapling retiré"
  else
    echo "  · $(basename "$vhost") : déjà retiré"
  fi
done
# Le cache d'agrafage devient inutile lui aussi.
sed -i '/^SSLStaplingCache/d' /etc/apache2/conf-available/zzz-senharmattan-perf.conf

echo "═══ 3/3 · Rechargement et contrôle ═══"
apache2ctl configtest
systemctl restart "php$PHPV-fpm"
systemctl reload apache2
sleep 2

systemctl is-active --quiet "php$PHPV-fpm" || { echo "  ✗ php$PHPV-fpm arrêté"; exit 1; }
systemctl is-active --quiet apache2        || { echo "  ✗ apache2 arrêté"; exit 1; }

echo "  ✓ workers FPM actifs : $(pgrep -c "php-fpm$PHPV" || echo '?')"
echo
echo "── Vérifications ──"
# Apache respawn ses workers après un reload : une vérification immédiate peut
# tomber sur la fenêtre de bascule et renvoyer 000. On réessaie avant de conclure,
# et on ne laisse jamais `set -e` interrompre le script sur un contrôle.
probe() {
  local label="$1" url="$2" out=""
  for _ in 1 2 3 4 5; do
    out="$(curl -s -o /dev/null --max-time 10 -w 'HTTP/%{http_version} code=%{http_code}' "$url" || true)"
    case "$out" in *"code=000"|"") sleep 2 ;; *) break ;; esac
  done
  printf '  %-9s: %s\n' "$label" "${out:-injoignable}"
}
probe Boutique https://senharmattan.com/
probe ERP      https://erp.senharmattan.com/
echo "✓ Terminé. Rollback : cp $POOL.bak.$STAMP $POOL && systemctl restart php$PHPV-fpm"
