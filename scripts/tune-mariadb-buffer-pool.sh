#!/usr/bin/env bash
# Porte innodb_buffer_pool_size de 128 Mo (défaut MariaDB) à 512 Mo.
#
# Contexte : la base dolibarr fait ~337 Mo pour un buffer pool de 128 Mo. Les pages
# chaudes (llx_product, llx_facturedet) étaient évincées entre deux visites du
# dashboard stock, d'où un premier chargement à ~4 s au lieu de ~250 ms.
# La machine a ~7,5 Go de RAM libre : 512 Mo fait tenir toute la base en cache.
#
# Applique le changement à chaud (sans redémarrer MariaDB) ET le persiste pour
# survivre aux redémarrages.
#
# Usage : sudo bash scripts/tune-mariadb-buffer-pool.sh

set -euo pipefail

CONF=/etc/mysql/mariadb.conf.d/50-server.cnf
NEW_SIZE=512M

if [[ $EUID -ne 0 ]]; then
  echo "Ce script doit être lancé avec sudo." >&2
  exit 1
fi

echo "== Avant =="
mariadb -e "SELECT @@innodb_buffer_pool_size/1024/1024 AS buffer_pool_mb;"

# 1. À chaud (dynamique depuis MariaDB 10.2 — pas de coupure de service).
echo "== Application à chaud =="
mariadb -e "SET GLOBAL innodb_buffer_pool_size = 536870912;"

# 2. Persistance dans la config.
echo "== Persistance dans $CONF =="
cp -n "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"

if grep -qE '^\s*#?\s*innodb_buffer_pool_size' "$CONF"; then
  sed -i -E "s|^\s*#?\s*innodb_buffer_pool_size.*|innodb_buffer_pool_size = $NEW_SIZE|" "$CONF"
  echo "  directive existante mise à jour"
else
  sed -i "/^\[mysqld\]/a innodb_buffer_pool_size = $NEW_SIZE" "$CONF"
  echo "  directive ajoutée sous [mysqld]"
fi

grep -n "innodb_buffer_pool_size" "$CONF"

echo "== Après =="
mariadb -e "SELECT @@innodb_buffer_pool_size/1024/1024 AS buffer_pool_mb;"

echo "Terminé — aucun redémarrage de MariaDB nécessaire."
