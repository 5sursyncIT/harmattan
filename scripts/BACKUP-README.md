# Sauvegarde & restauration — senharmattan

Snapshot **cohérent** des deux systèmes liés (clés étrangères `dolibarr_id` / ISBN) :

| # | Source | Contenu | Fichier dans le snapshot |
|---|--------|---------|--------------------------|
| 1 | SQLite `newsletter.sqlite` (~46 tables) | clients, paiements, POS, manuscrits, consignations, dépenses, contrats locaux | `newsletter.sqlite.gz` |
| 2 | MySQL Dolibarr | ERP complet (contrats, factures, produits, tiers) | `dolibarr-mysql.sql.gz` |
| 3 | Fichiers app | `manuscripts/`, `public/images/` (uploads uniques) | `files-app.tar.gz` |
| 4 | Documents Dolibarr | PDF factures/contrats générés | `dolibarr-documents.tar.gz` |

Chaque snapshot contient aussi `MANIFEST.txt`, `SHA256SUMS` et `backup.log`.

## Lancer manuellement
```bash
/var/www/html/senharmattan-shop/scripts/backup-full.sh
# Variables : BACKUP_ROOT (défaut /var/backups/senharmattan), RETENTION_DAYS (défaut 14)
```
> Exécuter en **root** pour capturer 100 % de `documents/` (sous-dossiers `www-data`).
> En utilisateur, le mysqldump reste complet ; seuls quelques PDF Dolibarr sont ignorés.

## Installation du cron quotidien (root, 03h00) — à faire une fois
```bash
sudo install -d -o root -g root -m 750 /var/backups/senharmattan
sudo tee /etc/cron.d/senharmattan-backup >/dev/null <<'EOF'
# Snapshot cohérent senharmattan — tous les jours à 03h00
0 3 * * * root /var/www/html/senharmattan-shop/scripts/backup-full.sh >/dev/null 2>&1
EOF
sudo systemctl restart cron
```
Vérifier le lendemain : `ls -lh /var/backups/senharmattan/latest/`

## Restauration

### 1. SQLite
```bash
# Arrêter l'app Node d'abord (sinon fichier verrouillé)
gzip -dc newsletter.sqlite.gz > /var/www/html/senharmattan-shop/newsletter.sqlite
chown youssoupha:youssoupha /var/www/html/senharmattan-shop/newsletter.sqlite
# Puis redémarrer l'app
```

### 2. MySQL Dolibarr
```bash
gzip -dc dolibarr-mysql.sql.gz | mysql -u dolibarr -p dolibarr
```

### 3. Fichiers application
```bash
tar xzf files-app.tar.gz -C /var/www/html/senharmattan-shop
```

### 4. Documents Dolibarr
```bash
tar xzf dolibarr-documents.tar.gz -C /var/www/html/dolibarr
chown -R www-data:www-data /var/www/html/dolibarr/documents
```

> **Cohérence** : toujours restaurer SQLite **et** MySQL du **même snapshot** (même horodatage),
> sinon les références croisées (ID Dolibarr en SQLite) pointent dans le vide.

## Vérifier un snapshot
```bash
cd /var/backups/senharmattan/latest
sha256sum -c SHA256SUMS      # intégrité des archives
gzip -t *.gz                 # validité gzip
```

## À prévoir (hors périmètre actuel)
- **Copie hors-site** : ce backup est local — il ne protège pas d'une perte du serveur entier.
  Ajouter un `rsync`/`rclone` du dossier vers un stockage distant après le snapshot.
- **Test de restauration** périodique sur un environnement jetable.
