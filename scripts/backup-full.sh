#!/usr/bin/env bash
#
# backup-full.sh — Snapshot COHÉRENT de tout le SI senharmattan.
#
# Capture au même instant :
#   1. SQLite locale  (newsletter.sqlite, ~46 tables métier) — backup à chaud via better-sqlite3
#   2. MySQL Dolibarr (mysqldump --single-transaction) — données ERP complètes
#   3. Fichiers app   (manuscripts/, public/images/) — uploads non régénérables
#   4. Documents Dolibarr (documents/) — PDF factures/contrats (nécessite root pour TOUT lire)
#
# Les deux bases sont liées par des clés étrangères (dolibarr_id, ISBN) : seul un
# instantané simultané garantit une restauration cohérente.
#
# Idéalement exécuté en ROOT (cron système) pour lire l'intégralité de documents/.
# Fonctionne aussi en utilisateur (youssoupha) : les fichiers Dolibarr non lisibles
# sont alors ignorés (le mysqldump reste complet — il passe par MySQL, pas par le FS).
#
# Variables surchargeables : BACKUP_ROOT, RETENTION_DAYS
set -euo pipefail

# ---- Configuration ---------------------------------------------------------
APP_DIR="/var/www/html/senharmattan-shop"
DOLI_DOCS="/var/www/html/dolibarr/documents"
SQLITE_DB="$APP_DIR/newsletter.sqlite"
ENV_FILE="$APP_DIR/.env"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/senharmattan}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TS"

# ---- Préparation -----------------------------------------------------------
if ! mkdir -p "$DEST" 2>/dev/null; then
  echo "ERREUR : impossible de créer $DEST" >&2
  echo "Crée le dossier une fois :  sudo install -d -o root -g root -m 750 $BACKUP_ROOT" >&2
  exit 1
fi

LOG="$DEST/backup.log"
exec > >(tee -a "$LOG") 2>&1

fail() { echo "[$(date '+%F %T')] ÉCHEC : $*" >&2; touch "$DEST/.FAILED"; }

echo "=============================================================="
echo "[$(date '+%F %T')] Snapshot senharmattan -> $DEST"
echo "  utilisateur : $(id -un)   rétention : ${RETENTION_DAYS}j"
echo "=============================================================="

# ---- 1. SQLite (backup à chaud, sûr en mode WAL) ---------------------------
echo "[1/4] SQLite (newsletter.sqlite)..."
if node -e '
  const path = process.argv[1], src = process.argv[2], out = process.argv[3];
  const Database = require(path + "/node_modules/better-sqlite3");
  const db = new Database(src);                 // connexion en ligne, non bloquante
  db.backup(out)
    .then(() => {
      const v = new Database(out, { readonly: true });
      const r = v.pragma("integrity_check", { simple: true });
      v.close(); db.close();
      if (r !== "ok") { console.error("integrity_check =", r); process.exit(2); }
      console.log("    integrity_check = ok");
    })
    .catch(e => { console.error(e.message); process.exit(1); });
' "$APP_DIR" "$SQLITE_DB" "$DEST/newsletter.sqlite"; then
    rm -f "$DEST/newsletter.sqlite-wal" "$DEST/newsletter.sqlite-shm"
    gzip -9 "$DEST/newsletter.sqlite"
    echo "    -> newsletter.sqlite.gz ($(du -h "$DEST/newsletter.sqlite.gz" | cut -f1))"
else
    fail "backup SQLite"
fi

# ---- 2. MySQL Dolibarr -----------------------------------------------------
echo "[2/4] MySQL Dolibarr (mysqldump)..."
get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
MYSQL_HOST="$(get_env MYSQL_HOST)";     MYSQL_HOST="${MYSQL_HOST:-localhost}"
MYSQL_USER="$(get_env MYSQL_USER)"
MYSQL_PASSWORD="$(get_env MYSQL_PASSWORD)"
MYSQL_DATABASE="$(get_env MYSQL_DATABASE)"

MY_CNF="$(mktemp)"; chmod 600 "$MY_CNF"
printf '[client]\nhost=%s\nuser=%s\npassword=%s\n' "$MYSQL_HOST" "$MYSQL_USER" "$MYSQL_PASSWORD" > "$MY_CNF"
trap 'rm -f "$MY_CNF"' EXIT

if mysqldump --defaults-extra-file="$MY_CNF" \
        --single-transaction --quick --routines --triggers --events \
        --default-character-set=utf8mb4 "$MYSQL_DATABASE" 2>>"$LOG" \
        | gzip -9 > "$DEST/dolibarr-mysql.sql.gz"; then
    # mysqldump | gzip masque le code retour de mysqldump : on vérifie le contenu
    if gzip -dc "$DEST/dolibarr-mysql.sql.gz" | tail -5 | grep -q 'Dump completed'; then
        echo "    -> dolibarr-mysql.sql.gz ($(du -h "$DEST/dolibarr-mysql.sql.gz" | cut -f1))"
    else
        fail "mysqldump incomplet (marqueur 'Dump completed' absent)"
    fi
else
    fail "mysqldump"
fi
rm -f "$MY_CNF"; trap - EXIT

# ---- 3. Fichiers application (uploads non régénérables) --------------------
# contract-signatures/ = scans des contrats signés à la main (preuve légale,
# non régénérable) ; l'empreinte SHA-256 ne vaut que si le scan est conservé.
echo "[3/4] Fichiers application (manuscripts/, public/images/, contract-signatures/)..."
if tar czf "$DEST/files-app.tar.gz" --ignore-failed-read \
        -C "$APP_DIR" manuscripts public/images contract-signatures 2>>"$LOG"; then
    echo "    -> files-app.tar.gz ($(du -h "$DEST/files-app.tar.gz" | cut -f1))"
else
    fail "archive fichiers application"
fi

# ---- 4. Documents Dolibarr (PDF) -------------------------------------------
echo "[4/4] Documents Dolibarr (documents/)..."
if [ "$(id -u)" -ne 0 ]; then
    echo "    AVERTISSEMENT : non-root — les sous-dossiers appartenant à www-data"
    echo "    (contract/, takeposconnector/, ...) seront IGNORÉS. Lance en root pour tout capturer."
fi
# --ignore-failed-read : on archive ce qui est lisible sans abandonner sur un refus
tar czf "$DEST/dolibarr-documents.tar.gz" --ignore-failed-read \
        --exclude='admin/backup' --exclude='dolibarr.log' --exclude='*/temp/*' \
        -C "$(dirname "$DOLI_DOCS")" "$(basename "$DOLI_DOCS")" 2>>"$LOG" \
    && echo "    -> dolibarr-documents.tar.gz ($(du -h "$DEST/dolibarr-documents.tar.gz" | cut -f1))" \
    || echo "    (archive partielle — voir backup.log)"

# ---- Empreintes + manifeste ------------------------------------------------
( cd "$DEST" && sha256sum ./*.gz > SHA256SUMS 2>/dev/null || true )
{
  echo "snapshot   : $TS"
  echo "généré par : $(id -un) sur $(hostname)"
  echo "sources    : SQLite=$SQLITE_DB  MySQL=$MYSQL_DATABASE@$MYSQL_HOST"
  echo "taille     : $(du -sh "$DEST" | cut -f1)"
} > "$DEST/MANIFEST.txt"

# ---- Pointeur 'latest' + rotation -----------------------------------------
ln -sfn "$DEST" "$BACKUP_ROOT/latest"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" \
    -exec rm -rf {} + 2>/dev/null || true

# ---- Bilan -----------------------------------------------------------------
echo "--------------------------------------------------------------"
if [ -e "$DEST/.FAILED" ]; then
    echo "[$(date '+%F %T')] TERMINÉ AVEC ERREURS — voir $LOG"
    rm -f "$DEST/.FAILED"
    exit 1
fi
echo "[$(date '+%F %T')] Snapshot OK — $(du -sh "$DEST" | cut -f1) dans $DEST"
echo "=============================================================="
