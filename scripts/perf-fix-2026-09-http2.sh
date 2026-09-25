#!/usr/bin/env bash
# Bascule Apache prefork+mod_php → event+PHP-FPM, puis activation de HTTP/2.
#
# POURQUOI : mod_http2 est installé mais inopérant sous mpm_prefork (Apache le
# journalise et sert quand même en HTTP/1.1 — vérifié : proto=1.1). Or le POS est
# une SPA consultée depuis Dakar à 110–380 ms de RTT, 2 % de perte et ~150 kbps :
# HTTP/1.1 y plafonne à 6 connexions, sans compression d'en-têtes, avec blocage
# de tête de ligne. HTTP/2 multiplexe tout sur une seule connexion TLS.
#
# BÉNÉFICE ANNEXE : prefork réserve un processus de 36 Mo par connexion
# (MaxRequestWorkers 150 → 5,4 Go potentiels). event gère les connexions par
# threads et laisse PHP à un pool FPM dimensionné à part.
#
# Prérequis vérifiés le 2026-09-01 : aucun php_value / php_flag dans les
# .htaccess ni dans la configuration Apache — c'est le blocage habituel d'une
# migration FPM, il est absent ici.
#
# Cette bascule redémarre Apache (coupure de quelques secondes).
# Rollback : sudo bash scripts/perf-fix-2026-09-http2-rollback.sh
#
# Usage : sudo bash scripts/perf-fix-2026-09-http2.sh
set -euo pipefail

PHPV="8.2"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Ce script doit être lancé avec sudo."
  exit 1
fi

echo "═══ 1/5 · Installation de php$PHPV-fpm ═══"
if ! dpkg -l | grep -q "php$PHPV-fpm"; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y "php$PHPV-fpm"
else
  echo "  · php$PHPV-fpm déjà installé"
fi

echo "═══ 2/5 · Report de la configuration PHP d'Apache vers FPM ═══"
APACHE_INI="/etc/php/$PHPV/apache2/php.ini"
FPM_INI="/etc/php/$PHPV/fpm/php.ini"
if [ -f "$APACHE_INI" ] && [ -f "$FPM_INI" ]; then
  cp -p "$FPM_INI" "$FPM_INI.bak.$STAMP"
  # Le php.ini d'Apache porte les réglages en production (memory_limit,
  # expose_php, tailles d'upload…). FPM doit partir du même état.
  cp -p "$APACHE_INI" "$FPM_INI"
  echo "  ✓ $APACHE_INI → $FPM_INI (ancien : $FPM_INI.bak.$STAMP)"
fi

echo "═══ 3/5 · Bascule des modules Apache ═══"
a2dismod "php$PHPV" mpm_prefork >/dev/null
a2enmod mpm_event proxy_fcgi setenvif http2 >/dev/null
a2enconf "php$PHPV-fpm" >/dev/null
echo "  ✓ mpm_prefork + mod_php désactivés ; mpm_event + proxy_fcgi + http2 activés"

echo "═══ 4/5 · Déclaration du protocole HTTP/2 ═══"
PROTO_CONF="/etc/apache2/conf-available/zzz-senharmattan-http2.conf"
cat > "$PROTO_CONF" <<'EOF'
# h2 en premier : les navigateurs qui le gèrent négocient HTTP/2 via ALPN,
# les autres retombent sur HTTP/1.1. h2c (clair) est inutile ici, tout le
# trafic public passe en TLS.
Protocols h2 http/1.1
H2Push off
EOF
a2enconf zzz-senharmattan-http2 >/dev/null
echo "  ✓ $PROTO_CONF"

echo "═══ 5/5 · Contrôle et redémarrage ═══"
apache2ctl configtest
systemctl restart "php$PHPV-fpm"
systemctl restart apache2
sleep 2

FAIL=0
systemctl is-active --quiet apache2       || { echo "  ✗ apache2 est arrêté"; FAIL=1; }
systemctl is-active --quiet "php$PHPV-fpm" || { echo "  ✗ php$PHPV-fpm est arrêté"; FAIL=1; }
if [ "$FAIL" -eq 1 ]; then
  echo "  → Rollback : sudo bash scripts/perf-fix-2026-09-http2-rollback.sh"
  exit 1
fi

echo
echo "── Vérifications ──"
# Apache respawn ses workers après un restart : on réessaie avant de conclure,
# et `|| true` empêche `set -e` d'interrompre le script sur un simple contrôle.
probe() {
  local label="$1" url="$2" hdr="${3:-}" out=""
  for _ in 1 2 3 4 5; do
    out="$(curl -s -o /dev/null --max-time 10 ${hdr:+-H "$hdr"} \
           -w 'HTTP/%{http_version}  code=%{http_code}' "$url" || true)"
    case "$out" in *"code=000"|"") sleep 2 ;; *) break ;; esac
  done
  printf '  %-12s: %s\n' "$label" "${out:-injoignable}"
}
echo -n "  MPM         : "; apache2ctl -V 2>/dev/null | grep -i 'Server MPM' | awk '{print $3}'
probe Boutique     https://senharmattan.com/
probe "ERP (PHP)"  https://erp.senharmattan.com/
# L'API exige la clé : sans elle Dolibarr répond 401, ce qui prouve déjà que
# PHP-FPM traite la requête, mais 200 est plus lisible.
DOLKEY="$(grep -m1 '^DOLIBARR_API_KEY=' /var/www/html/senharmattan-shop/.env | cut -d= -f2- | tr -d '"'"'"'')"
probe "API Dolibarr" "http://localhost/dolibarr/htdocs/api/index.php/status" "DOLAPIKEY: $DOLKEY"

echo
echo "✓ Terminé. Si l'ERP ou l'API renvoie une erreur, PHP-FPM ne sert pas"
echo "  encore le vhost : lancer le rollback et me le signaler."
