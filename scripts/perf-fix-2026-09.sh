#!/usr/bin/env bash
# Correctifs de performance — audit du 2026-09-01 (lenteurs POS).
#
# Corrige, dans l'ordre d'impact mesuré :
#   1. Synchro PrestaShop morte dans le chemin critique de chaque vente
#      (module mycyberoffice → SOAP vers http://senharmattan.com/, endpoint
#      disparu, 0,17–1,46 s gaspillées PAR LIGNE de panier, plafond 320 s).
#   2. Module DebugBar laissé actif en production.
#   3. Index manquant sur les requêtes POS de llx_facture.
#   4. Timeouts absents/démesurés dans les modules PHP custom (filet de
#      sécurité si un module est réactivé un jour).
#   5. Reprise TLS désactivée + pas d'agrafage OCSP (2 RTT par connexion).
#   6. Slow-start TCP relancé après chaque inactivité (lien Dakar à 200 ms).
#   7. Résolution DNS publique pour les appels internes.
#
# Idempotent : relançable sans risque. Chaque fichier modifié est sauvegardé
# en .bak.<horodatage>. Rollback : scripts/perf-fix-2026-09-rollback.sh
#
# NE FAIT PAS la bascule mpm_event + PHP-FPM (requise pour HTTP/2) :
# voir scripts/perf-fix-2026-09-http2.sh, à lancer séparément.
#
# Usage : sudo bash scripts/perf-fix-2026-09.sh
set -euo pipefail

APP_DIR="/var/www/html/senharmattan-shop"
DOL_CUSTOM="/var/www/html/dolibarr/htdocs/custom"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_LIST="/var/lib/senharmattan-perf-fix-$STAMP.manifest"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Ce script doit être lancé avec sudo."
  exit 1
fi

: > "$BACKUP_LIST"

backup() {
  local f="$1"
  [ -f "$f" ] || return 0
  # Un même fichier peut être patché par deux étapes (vhost SSL : TLS + proxy) :
  # on ne garde que la sauvegarde d'origine.
  [ -f "$f.bak.$STAMP" ] && return 0
  cp -p "$f" "$f.bak.$STAMP"
  echo "$f.bak.$STAMP" >> "$BACKUP_LIST"
  echo "    sauvegarde → $f.bak.$STAMP"
}

echo "═══ 1/7 · Dolibarr : désactivation des modules morts ═══"

MYSQL_PASS="$(grep -m1 -E '^MYSQL_PASSWORD=|^MYSQL_PASS=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
MYSQL_USER="$(grep -m1 '^MYSQL_USER=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
MYSQL_DB="$(grep -m1 '^MYSQL_DATABASE=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"'"'"'')"
export MYSQL_PWD="$MYSQL_PASS"
dbq() { mysql -u "$MYSQL_USER" -h 127.0.0.1 "$MYSQL_DB" -N -e "$1"; }

echo "  → rollback des constantes :"
dbq "SELECT CONCAT('UPDATE llx_const SET value=''', value, ''' WHERE name=''', name, ''';')
     FROM llx_const
     WHERE name IN ('MAIN_MODULE_MYCYBEROFFICE','MAIN_MODULE_DEBUGBAR',
                    'MAIN_ENABLE_LOG_TO_HTML','CYBEROFFICE_stock');" \
  | tee "/var/lib/senharmattan-perf-fix-$STAMP.const-rollback.sql" | sed 's/^/    /'
echo "/var/lib/senharmattan-perf-fix-$STAMP.const-rollback.sql" >> "$BACKUP_LIST"

# mycyberoffice : Dolibarr charge un trigger interface_NN_<module>_*.class.php
# uniquement si isModEnabled('<module>') — passer MAIN_MODULE_MYCYBEROFFICE à 0
# neutralise donc l'appel SOAP à la racine du problème.
dbq "UPDATE llx_const SET value='0' WHERE name='MAIN_MODULE_MYCYBEROFFICE';"
dbq "UPDATE llx_const SET value='0' WHERE name='CYBEROFFICE_stock';"
dbq "UPDATE llx_const SET value='0' WHERE name='MAIN_MODULE_DEBUGBAR';"
dbq "UPDATE llx_const SET value='0' WHERE name='MAIN_ENABLE_LOG_TO_HTML';"
echo "  ✓ mycyberoffice, CYBEROFFICE_stock, DebugBar, log-to-HTML désactivés"

echo "═══ 2/7 · Index POS sur llx_facture ═══"
if [ -z "$(dbq "SHOW INDEX FROM llx_facture WHERE Key_name='idx_facture_pos_source';")" ]; then
  dbq "CREATE INDEX idx_facture_pos_source ON llx_facture (module_source, pos_source, datef);"
  echo "  ✓ idx_facture_pos_source créé"
else
  echo "  · idx_facture_pos_source déjà présent"
fi

echo "═══ 3/7 · Timeouts des modules PHP custom ═══"

PSWS="$DOL_CUSTOM/mycyberoffice/class/PSWebServiceLibrary.php"
if [ -f "$PSWS" ] && ! grep -q 'CURLOPT_TIMEOUT' "$PSWS"; then
  backup "$PSWS"
  # Aucun timeout n'était posé : cURL attend indéfiniment si la cible ne répond pas.
  perl -0pi -e "s/(\Q\$defaultParams = array(\E\s*\n)/\$1\t\t\tCURLOPT_TIMEOUT => 5,\n\t\t\tCURLOPT_CONNECTTIMEOUT => 2,\n/" "$PSWS"
  php -l "$PSWS" >/dev/null || { echo "  ✗ syntaxe cassée, restauration"; cp -p "$PSWS.bak.$STAMP" "$PSWS"; exit 1; }
  grep -q 'CURLOPT_TIMEOUT' "$PSWS" && echo "  ✓ PSWebServiceLibrary : timeouts cURL 5 s / connect 2 s"
else
  echo "  · PSWebServiceLibrary : déjà borné (ou absent)"
fi

MYCYBER="$DOL_CUSTOM/mycyberoffice/core/triggers/interface_90_mycyberoffice_Cust.class.php"
if [ -f "$MYCYBER" ] && grep -q "default_socket_timeout', 320" "$MYCYBER"; then
  backup "$MYCYBER"
  sed -i "s/default_socket_timeout', 320/default_socket_timeout', 5/g" "$MYCYBER"
  php -l "$MYCYBER" >/dev/null || { echo "  ✗ syntaxe cassée, restauration"; cp -p "$MYCYBER.bak.$STAMP" "$MYCYBER"; exit 1; }
  echo "  ✓ trigger mycyberoffice : socket timeout 320 s → 5 s"
else
  echo "  · trigger mycyberoffice : déjà borné (ou absent)"
fi

WEBHOOK="$DOL_CUSTOM/senharmattansync/core/triggers/interface_99_modSenharmattansync_Webhook.class.php"
if [ -f "$WEBHOOK" ] && grep -q 'RETRY_DELAYS = \[1, 3, 8\]' "$WEBHOOK"; then
  backup "$WEBHOOK"
  # Le webhook est appelé de façon SYNCHRONE pendant la transaction Dolibarr :
  # 3 essais × 10 s + sleep(1) + sleep(3) = jusqu'à 34 s de blocage sur une
  # simple modification de fiche produit. La boutique répond en < 1 s ou pas.
  sed -i \
    -e 's/MAX_RETRIES  *= 3;/MAX_RETRIES = 2;/' \
    -e 's/RETRY_DELAYS = \[1, 3, 8\];.*/RETRY_DELAYS = [1, 2];/' \
    -e 's/TIMEOUT  *= 10;.*/TIMEOUT = 5;/' \
    "$WEBHOOK"
  php -l "$WEBHOOK" >/dev/null || { echo "  ✗ syntaxe cassée, restauration"; cp -p "$WEBHOOK.bak.$STAMP" "$WEBHOOK"; exit 1; }
  echo "  ✓ webhook senharmattansync : 34 s max → 12 s max"
else
  echo "  · webhook senharmattansync : déjà borné (ou absent)"
fi

echo "═══ 4/7 · Apache : reprise TLS, agrafage OCSP, réutilisation du proxy ═══"

PERFCONF="/etc/apache2/conf-available/zzz-senharmattan-perf.conf"
cat > "$PERFCONF" <<'EOF'
# Réglages de performance — audit 2026-09-01.
# Le cache d'agrafage OCSP est une directive de portée serveur : elle doit être
# hors VirtualHost. `SSLUseStapling on` est posé dans chaque vhost SSL, car
# options-ssl-apache.conf (géré par certbot) y est inclus après ce fichier.
SSLStaplingCache shmcb:/var/run/ocsp(128000)

# Une caisse enregistreuse reste inactive entre deux ventes : 5 s de keep-alive
# forçaient une nouvelle poignée de main TLS à chaque encaissement.
KeepAliveTimeout 30
EOF
a2enconf zzz-senharmattan-perf >/dev/null
echo "  ✓ $PERFCONF"

for vhost in /etc/apache2/sites-available/senharmattan-le-ssl.conf \
             /etc/apache2/sites-available/erp-le-ssl.conf; do
  [ -f "$vhost" ] || continue
  if ! grep -q 'SSLSessionTickets on' "$vhost"; then
    backup "$vhost"
    # options-ssl-apache.conf pose « SSLSessionTickets off » : sans tickets, TLS 1.3
    # ne peut pas reprendre de session → poignée de main complète (2 RTT) à chaque
    # connexion, soit ~0,4 s par connexion sur le lien Dakar.
    sed -i 's#^\(\s*\)\(Include /etc/letsencrypt/options-ssl-apache.conf\)#\1\2\n\1SSLSessionTickets on\n\1SSLUseStapling on#' "$vhost"
    echo "  ✓ $(basename "$vhost") : reprise de session TLS + agrafage OCSP"
  else
    echo "  · $(basename "$vhost") : déjà configuré"
  fi
done

for vhost in /etc/apache2/sites-available/senharmattan.conf \
             /etc/apache2/sites-available/senharmattan-le-ssl.conf; do
  [ -f "$vhost" ] || continue
  if grep -q 'ProxyPass        / http://127.0.0.1:3000/$' "$vhost"; then
    backup "$vhost"
    # Sans enablereuse, mod_proxy ouvre une connexion TCP vers Node à CHAQUE requête.
    sed -i 's#^\(\s*ProxyPass        / http://127.0.0.1:3000/\)$#\1 enablereuse=on#' "$vhost"
    echo "  ✓ $(basename "$vhost") : réutilisation des connexions vers Node"
  else
    echo "  · $(basename "$vhost") : proxy déjà configuré"
  fi
done

echo "  → contrôle de la configuration Apache…"
apache2ctl configtest
systemctl reload apache2
echo "  ✓ Apache rechargé"

echo "═══ 5/7 · Réglages TCP ═══"
SYSCTL="/etc/sysctl.d/99-senharmattan-perf.conf"
cat > "$SYSCTL" <<'EOF'
# Le POS reste inactif entre deux ventes. Avec slow_start_after_idle=1, chaque
# connexion keep-alive repart à cwnd=10 après ~200 ms d'inactivité : sur un lien
# à 200 ms de RTT et 2 % de perte, chaque vente redémarrait en slow-start.
net.ipv4.tcp_slow_start_after_idle = 0
EOF
if modprobe tcp_bbr 2>/dev/null && grep -q bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
  echo "tcp_bbr" > /etc/modules-load.d/bbr.conf
  # cubic s'effondre à 2 % de perte ; BBR tient le débit sur lien lossy.
  echo "net.ipv4.tcp_congestion_control = bbr" >> "$SYSCTL"
  echo "  ✓ BBR activé (cubic s'effondrait à 2 % de perte mesurée)"
else
  echo "  · BBR indisponible sur ce noyau — cubic conservé"
fi
sysctl -p "$SYSCTL" | sed 's/^/    /'

echo "═══ 6/7 · DNS interne ═══"
if ! grep -q 'senharmattan.com' /etc/hosts; then
  backup /etc/hosts
  # La résolution publique de senharmattan.com depuis le VPS coûtait 0,01 à 0,95 s
  # (résolveurs Contabo erratiques) pour un aller-retour qui revient sur la machine.
  printf '\n# Résolution locale : évite un aller-retour DNS public pour les appels internes\n127.0.0.1 senharmattan.com www.senharmattan.com erp.senharmattan.com\n' >> /etc/hosts
  echo "  ✓ senharmattan.com / www / erp → 127.0.0.1"
else
  echo "  · /etc/hosts : déjà configuré"
fi

echo "═══ 7/7 · Journaux et redémarrage applicatif ═══"
journalctl --vacuum-size=200M 2>&1 | tail -1 | sed 's/^/  /'
systemctl restart senharmattan-shop
sleep 3
systemctl is-active --quiet senharmattan-shop \
  && echo "  ✓ senharmattan-shop redémarré" \
  || { echo "  ✗ senharmattan-shop ne démarre pas :"; journalctl -u senharmattan-shop -n 30 --no-pager; exit 1; }

echo
echo "════════════════════════════════════════════════════════"
echo "✓ Terminé. Sauvegardes listées dans : $BACKUP_LIST"
echo
echo "  Reste à faire séparément (bascule plus lourde) :"
echo "    sudo bash scripts/perf-fix-2026-09-http2.sh"
echo "    → mpm_event + PHP-FPM, prérequis obligatoire de HTTP/2"
echo "════════════════════════════════════════════════════════"
