#!/usr/bin/env bash
# Rollback de scripts/perf-fix-2026-09-http2.sh : retour à mpm_prefork + mod_php.
#
# Usage : sudo bash scripts/perf-fix-2026-09-http2-rollback.sh
set -euo pipefail

PHPV="8.2"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Ce script doit être lancé avec sudo."
  exit 1
fi

echo "→ Retour à mpm_prefork + mod_php$PHPV…"
a2disconf zzz-senharmattan-http2 >/dev/null 2>&1 || true
a2disconf "php$PHPV-fpm"          >/dev/null 2>&1 || true
a2dismod http2 proxy_fcgi mpm_event >/dev/null 2>&1 || true
a2enmod mpm_prefork "php$PHPV"      >/dev/null

apache2ctl configtest
systemctl restart apache2
systemctl stop "php$PHPV-fpm" 2>/dev/null || true

echo -n "  MPM      : "; apache2ctl -V 2>/dev/null | grep -i 'Server MPM' | awk '{print $3}'
echo -n "  Boutique : "; curl -s -o /dev/null -w 'HTTP/%{http_version}  code=%{http_code}\n' https://senharmattan.com/
echo -n "  ERP      : "; curl -s -o /dev/null -w 'HTTP/%{http_version}  code=%{http_code}\n' https://erp.senharmattan.com/
echo "✓ Rollback effectué."
