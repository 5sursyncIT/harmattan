#!/usr/bin/env bash
# Réconciliation quotidienne : classe « Payée » toute facture dont remaintopay = 0
# mais restée « Commencée » (règlement Dolibarr saisi sans cocher « classer payée »).
# Installé en cron youssoupha (lit .env, mode 640). Voir fix-commencee-payees.mjs.
set -euo pipefail
cd /var/www/html/senharmattan-shop
LOG_DIR=scripts/logs
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/reconcile-payees.log"
{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') ====="
  /usr/bin/node scripts/fix-commencee-payees.mjs --apply
  echo
} >> "$LOG" 2>&1
