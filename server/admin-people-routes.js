// Admin "people" management — e-commerce customers + portal authors.
// Read-only listing + detail views + password reset for both.
// Panel admin dashboard consumes these endpoints.
import { Router } from 'express';
import axios from 'axios';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { slugify, generateUniqueSlug } from './author-public-routes.js';
import { findExistingTier, validateTierIdentity, buildTierName, TYPENT_PARTICULIER } from './tier-dedup.js';
import { buildSocieteReportPdf } from './societe-report.js';
import { computeRoyaltyBreakdown } from './royalties.js';

// Convertit un buffer ODT en PDF via LibreOffice headless. Le modèle de devis
// (module custom devislibrairie) génère de l'ODT, pas du PDF — sans conversion,
// le navigateur recevait un ODT étiqueté application/pdf → « Invalid PDF structure ».
function odtBufferToPdf(odtBuf) {
  const dir = join('/tmp', `propalpdf-${Date.now()}-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    const odtPath = join(dir, 'doc.odt');
    writeFileSync(odtPath, odtBuf);
    const profile = join(dir, 'profile');
    mkdirSync(profile, { recursive: true });
    execFileSync('soffice', [
      '--headless', '--norestore', '--nologo', '--nofirststartwizard',
      `-env:UserInstallation=file://${profile}`,
      '--convert-to', 'pdf', '--outdir', dir, odtPath,
    ], { stdio: 'pipe', timeout: 60000 });
    const pdfPath = join(dir, 'doc.pdf');
    if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée (soffice)');
    return readFileSync(pdfPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const DOC_BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/document-builddoc.php';
const DOLIBARR_WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Photos auteurs : stockées dans public/ (persiste aux rebuilds, copié vers dist
// au build) et servies à l'exécution via le montage /images de index.js.
const AUTHOR_PHOTOS_DIR = join(__dirname, '..', 'public', 'images', 'authors');
if (!existsSync(AUTHOR_PHOTOS_DIR)) mkdirSync(AUTHOR_PHOTOS_DIR, { recursive: true });

const authorPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Détecte le format réel via les magic bytes (ne pas se fier à l'extension).
function detectImageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

export function createAdminPeopleRouter({ db, dolibarrPool, auth, csrfProtection, transporter }) {
  const router = Router();

  function safeLike(q) {
    return String(q || '').replace(/[%_\\]/g, '\\$&').slice(0, 100);
  }

  // Defense-in-depth : verrouille certaines actions sensibles à une liste de rôles,
  // en plus du RBAC global par préfixe (admin-routes.js). Évite qu'un futur ajout au
  // RBAC global ouvre involontairement une action financière ou un reset password.
  function requireRoles(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.admin?.role)) {
        return res.status(403).json({ error: 'Action non autorisée pour votre profil' });
      }
      next();
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CUSTOMERS (e-commerce accounts)
  // ═══════════════════════════════════════════════════════════

  router.get('/customers', auth, (req, res) => {
    try {
      const { q = '', page = 1, limit = 20 } = req.query;
      const pageInt = Math.max(1, parseInt(page) || 1);
      const limitInt = Math.min(100, parseInt(limit) || 20);
      const offset = (pageInt - 1) * limitInt;

      let where = '';
      const params = [];
      if (q) {
        where = `WHERE email LIKE ? OR firstname LIKE ? OR lastname LIKE ? OR phone LIKE ?`;
        const pat = `%${safeLike(q)}%`;
        params.push(pat, pat, pat, pat);
      }

      const total = db.prepare(`SELECT COUNT(*) AS n FROM customers ${where}`).get(...params).n;
      const rows = db.prepare(
        `SELECT c.id, c.dolibarr_id, c.email, c.firstname, c.lastname, c.phone, c.address, c.city, c.created_at,
                (SELECT COUNT(*) FROM preorders p WHERE p.customer_id = c.id) AS preorder_count,
                (SELECT COUNT(*) FROM customer_sessions s WHERE s.customer_id = c.id AND s.expires_at > datetime('now')) AS active_sessions
         FROM customers c
         ${where}
         ORDER BY c.id DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limitInt, offset);

      res.json({
        customers: rows,
        total,
        page: pageInt,
        pages: Math.ceil(total / limitInt),
      });
    } catch (err) {
      console.error('Customers list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement clients' });
    }
  });

  router.get('/customers/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const customer = db.prepare(
        `SELECT id, dolibarr_id, email, firstname, lastname, phone, address, city, created_at
         FROM customers WHERE id = ?`
      ).get(id);
      if (!customer) return res.status(404).json({ error: 'Client introuvable' });

      // Préco commandes locales
      const preorders = db.prepare(
        `SELECT id, preorder_ref, created_at, status, product_label AS book_title,
                quantity, total_price_ttc AS total_amount
         FROM preorders WHERE customer_id = ? ORDER BY id DESC LIMIT 50`
      ).all(id);

      // Historique paiements liés à cet email
      const payments = db.prepare(
        `SELECT order_ref AS order_id, payment_method, payment_status, amount_expected, amount_received,
                transaction_ref, created_at
         FROM order_payments WHERE customer_email = ? ORDER BY id DESC LIMIT 50`
      ).all(customer.email);

      // Factures + devis Dolibarr si dolibarr_id est renseigné
      let invoices = [];
      let invoiceTotals = { count: 0, total_ht: 0, total_ttc: 0 };
      let quotes = [];
      let quoteTotals = { count: 0, total_ht: 0, total_ttc: 0 };
      let societe = null;
      if (customer.dolibarr_id && dolibarrPool) {
        try {
          const [rows] = await dolibarrPool.query(
            `SELECT f.rowid AS id, f.ref, f.datef AS date, f.total_ht, f.total_ttc, f.paye, f.fk_statut, f.type,
                    COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
             FROM llx_facture f WHERE f.fk_soc = ? ORDER BY f.rowid DESC LIMIT 50`,
            [customer.dolibarr_id]
          );
          invoices = rows;
          const [[itotals]] = await dolibarrPool.query(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total_ht), 0) AS total_ht,
                    COALESCE(SUM(total_ttc), 0) AS total_ttc
             FROM llx_facture WHERE fk_soc = ?`,
            [customer.dolibarr_id]
          );
          invoiceTotals = itotals;
        } catch (dolErr) {
          console.warn('Customer invoice fetch warning:', dolErr.message);
        }
        try {
          const [rows] = await dolibarrPool.query(
            `SELECT rowid AS id, ref, datep AS date, total_ht, total_ttc, fk_statut
             FROM llx_propal WHERE fk_soc = ? ORDER BY rowid DESC LIMIT 50`,
            [customer.dolibarr_id]
          );
          quotes = rows;
          const [[qtotals]] = await dolibarrPool.query(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total_ht), 0) AS total_ht,
                    COALESCE(SUM(total_ttc), 0) AS total_ttc
             FROM llx_propal WHERE fk_soc = ?`,
            [customer.dolibarr_id]
          );
          quoteTotals = qtotals;
        } catch (dolErr) {
          console.warn('Customer quotes fetch warning:', dolErr.message);
        }
        try {
          const [[soc]] = await dolibarrPool.query(
            `SELECT rowid AS id, nom, code_client, code_fournisseur, client, fournisseur,
                    siret, tva_intra, phone, email, town, zip, address, note_private
             FROM llx_societe WHERE rowid = ?`,
            [customer.dolibarr_id]
          );
          societe = soc || null;
        } catch (dolErr) {
          console.warn('Customer societe fetch warning:', dolErr.message);
        }
      }

      res.json({ customer, societe, preorders, payments, invoices, invoiceTotals, quotes, quoteTotals });
    } catch (err) {
      console.error('Customer detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement client' });
    }
  });

  // Pré-création de la table pour que les requêtes de diagnostic soient fiables
  // (évite l'ambiguïté « table absente » vs « endpoint jamais appelé »).
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    email TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at DATETIME NOT NULL
  )`);

  // Reset password → envoie email de réinitialisation. Le reset lui-même se fait
  // via la page /reinitialiser-mdp (ResetPasswordPage), pas /mot-de-passe-oublie
  // qui n'est que le formulaire de demande.
  router.post('/customers/:id/reset-password', auth, requireRoles('super_admin', 'admin', 'librarian'), csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const customer = db.prepare('SELECT email, firstname FROM customers WHERE id = ?').get(id);
      if (!customer) return res.status(404).json({ error: 'Client introuvable' });
      if (!customer.email) return res.status(400).json({ error: 'Ce client n\'a pas d\'adresse email enregistrée' });

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare('INSERT OR REPLACE INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)')
        .run(customer.email, token, expires);

      const siteUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const resetLink = `${siteUrl}/reinitialiser-mdp?token=${encodeURIComponent(token)}&email=${encodeURIComponent(customer.email)}`;

      if (!transporter) {
        console.error('[RESET] Transporter SMTP indisponible');
        return res.status(503).json({ error: 'Service email non configuré' });
      }

      try {
        const info = await transporter.sendMail({
          from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
          to: customer.email,
          subject: 'Réinitialisation de votre mot de passe',
          html: `<p>Bonjour ${customer.firstname || ''},</p>
                 <p>Un administrateur a demandé une réinitialisation de votre mot de passe.</p>
                 <p><a href="${resetLink}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Réinitialiser</a></p>
                 <p>Ce lien expire dans 1 heure.</p>`,
        });
        console.log(`[RESET] Email client envoyé à ${customer.email} (messageId=${info?.messageId || '?'})`);
      } catch (mailErr) {
        console.error('[RESET] Échec envoi email client:', mailErr);
        db.prepare('DELETE FROM password_resets WHERE email = ?').run(customer.email);
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin?.username || 'unknown', 'customer_reset_password_failed', `Échec envoi à ${customer.email}: ${mailErr.message}`);
        return res.status(502).json({ error: `Échec envoi email : ${mailErr.message}` });
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'customer_reset_password', `Reset MDP envoyé à ${customer.email}`);

      res.json({ success: true, email: customer.email });
    } catch (err) {
      console.error('Customer reset password error:', err);
      res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // AUTHORS (editorial portal accounts)
  // ═══════════════════════════════════════════════════════════

  router.get('/authors', auth, (req, res) => {
    try {
      const { q = '', page = 1, limit = 20 } = req.query;
      const pageInt = Math.max(1, parseInt(page) || 1);
      const limitInt = Math.min(100, parseInt(limit) || 20);
      const offset = (pageInt - 1) * limitInt;

      let where = '';
      const params = [];
      if (q) {
        where = `WHERE email LIKE ? OR firstname LIKE ? OR lastname LIKE ? OR phone LIKE ?`;
        const pat = `%${safeLike(q)}%`;
        params.push(pat, pat, pat, pat);
      }

      const total = db.prepare(`SELECT COUNT(*) AS n FROM authors ${where}`).get(...params).n;
      const rows = db.prepare(
        `SELECT a.id, a.email, a.firstname, a.lastname, a.phone, a.dolibarr_thirdparty_id,
                a.email_verified, a.created_at, a.slug, a.public_listed, a.display_name,
                (SELECT COUNT(*) FROM manuscripts m WHERE m.author_id = a.id) AS manuscript_count,
                (SELECT current_stage FROM manuscripts m WHERE m.author_id = a.id ORDER BY m.id DESC LIMIT 1) AS latest_stage,
                (SELECT COUNT(*) FROM author_sessions s WHERE s.author_id = a.id AND s.expires_at > datetime('now')) AS active_sessions
         FROM authors a
         ${where}
         ORDER BY a.id DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limitInt, offset);

      res.json({
        authors: rows,
        total,
        page: pageInt,
        pages: Math.ceil(total / limitInt),
      });
    } catch (err) {
      console.error('Authors list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement auteurs' });
    }
  });

  router.get('/authors/:id', auth, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare(
        `SELECT id, email, firstname, lastname, phone, dolibarr_thirdparty_id, email_verified, created_at,
                slug, display_name, bio, photo_url, website,
                social_twitter, social_instagram, social_linkedin, social_facebook, public_listed
         FROM authors WHERE id = ?`
      ).get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });

      const manuscripts = db.prepare(
        `SELECT id, ref, title, genre, current_stage AS stage, created_at
         FROM manuscripts WHERE author_id = ? ORDER BY id DESC LIMIT 50`
      ).all(id);

      const totals = db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN current_stage IN ('contract_signed','in_correction','correction_author_review','in_editorial','editorial_validated','cover_design','bat_author_review','print_preparation','printing','printed') THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN current_stage = 'evaluation_negative' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN current_stage IN ('submitted','in_evaluation') THEN 1 ELSE 0 END) AS pending
         FROM manuscripts WHERE author_id = ?`
      ).get(id);

      res.json({ author, manuscripts, totals });
    } catch (err) {
      console.error('Author detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement auteur' });
    }
  });

  // POST /api/admin/authors — création inline depuis BookForm (Phase 4 refactor auteur)
  // Minimal : firstname + lastname (display_name auto, slug auto, email factice unique).
  router.post('/authors', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, (req, res) => {
    try {
      const firstname = String(req.body.firstname || '').trim().slice(0, 80);
      const lastname  = String(req.body.lastname  || '').trim().slice(0, 80);
      if (!lastname && !firstname) {
        return res.status(400).json({ error: 'firstname ou lastname requis' });
      }
      const displayName = `${firstname} ${lastname}`.trim();
      const slug = generateUniqueSlug(db, displayName);
      const email = String(req.body.email || '').trim() || `auteur+${slug}@senharmattan.local`;

      // Garde-fou doublon : si display_name (normalisé) déjà présent, renvoie l'existant
      const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
      const existing = db.prepare(`SELECT id, display_name, slug FROM authors WHERE LOWER(display_name) = LOWER(?)`).get(displayName);
      if (existing && norm(existing.display_name) === norm(displayName)) {
        return res.status(200).json({ created: false, ...existing });
      }

      const r = db.prepare(
        `INSERT INTO authors (email, password, firstname, lastname, display_name, slug, public_listed) VALUES (?, '', ?, ?, ?, ?, 0)`
      ).run(email, firstname, lastname, displayName, slug);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_create_inline', `#${r.lastInsertRowid} ${displayName} (slug=${slug})`);

      res.status(201).json({ created: true, id: r.lastInsertRowid, display_name: displayName, slug, firstname, lastname });
    } catch (err) {
      console.error('Author inline create error:', err.message);
      res.status(500).json({ error: 'Erreur création auteur' });
    }
  });

  // PUT /api/admin/authors/:id — édition du profil public (admin)
  router.put('/authors/:id', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare(
        'SELECT id, firstname, lastname, email, phone, slug, dolibarr_thirdparty_id FROM authors WHERE id = ?'
      ).get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });

      const {
        firstname, lastname, email, phone,
        display_name, bio, photo_url, website,
        social_twitter, social_instagram, social_linkedin, social_facebook,
        public_listed, slug: customSlug,
      } = req.body;

      // ── Identité (prénom / nom / email / téléphone) — éditable par les admins ──
      // Une clé absente du body = champ inchangé (compat sauvegardes "profil public" seul).
      const finalFirstname = firstname !== undefined ? String(firstname).trim() : (author.firstname || '');
      const finalLastname = lastname !== undefined ? String(lastname).trim() : (author.lastname || '');
      if (!`${finalFirstname} ${finalLastname}`.trim()) {
        return res.status(400).json({ error: 'Le nom de l’auteur ne peut pas être vide' });
      }

      let finalEmail = author.email;
      if (email !== undefined) {
        const e = String(email).trim().toLowerCase();
        if (e) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
            return res.status(400).json({ error: 'Adresse email invalide' });
          }
          const clash = db.prepare('SELECT id FROM authors WHERE LOWER(email) = ? AND id != ?').get(e, id);
          if (clash) return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre auteur' });
          finalEmail = e;
        } else {
          finalEmail = null; // email effacé (auteur sans compte de connexion)
        }
      }

      const finalPhone = phone !== undefined ? (String(phone).trim() || null) : author.phone;

      // Slug : si fourni explicitement, on l'utilise (unique). Sinon, dérivé du display_name.
      let finalSlug = author.slug;
      let finalDisplay = display_name && String(display_name).trim()
        ? String(display_name).trim()
        : `${finalFirstname} ${finalLastname}`.trim();

      const desiredSlug = customSlug ? slugify(customSlug) : (author.slug || slugify(finalDisplay));
      if (desiredSlug && desiredSlug !== author.slug) {
        finalSlug = generateUniqueSlug(db, desiredSlug, id);
      } else if (!author.slug) {
        finalSlug = generateUniqueSlug(db, finalDisplay, id);
      }

      db.prepare(
        `UPDATE authors SET
           firstname = ?, lastname = ?, email = ?, phone = ?,
           display_name = ?, slug = ?, bio = ?, photo_url = ?, website = ?,
           social_twitter = ?, social_instagram = ?, social_linkedin = ?, social_facebook = ?,
           public_listed = ?
         WHERE id = ?`
      ).run(
        finalFirstname,
        finalLastname,
        finalEmail,
        finalPhone,
        finalDisplay,
        finalSlug,
        bio || null,
        photo_url || null,
        website || null,
        social_twitter || null,
        social_instagram || null,
        social_linkedin || null,
        social_facebook || null,
        public_listed ? 1 : 0,
        id,
      );

      // ── Synchronisation vers la fiche tiers Dolibarr liée (nom / email / téléphone) ──
      // Le nom corrigé doit apparaître sur contrats, factures et droits d'auteur.
      let dolibarrSynced = null; // null = pas de tiers lié ; true/false sinon
      if (author.dolibarr_thirdparty_id && dolibarrPool) {
        const dolibarrName = `${finalFirstname} ${finalLastname}`.trim() || finalDisplay;
        try {
          await dolibarrPool.query(
            'UPDATE llx_societe SET nom = ?, email = ?, phone = ?, tms = NOW() WHERE rowid = ?',
            [dolibarrName, finalEmail, finalPhone, author.dolibarr_thirdparty_id]
          );
          dolibarrSynced = true;
        } catch (syncErr) {
          console.error('Author→Dolibarr sync error:', syncErr.message);
          dolibarrSynced = false;
        }
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(
          req.admin?.username || 'unknown',
          'author_update_profile',
          `#${id} ${finalDisplay} (slug=${finalSlug}, public=${public_listed ? 1 : 0}, dolibarr_sync=${dolibarrSynced})`,
        );

      res.json({
        success: true, id, slug: finalSlug, display_name: finalDisplay,
        firstname: finalFirstname, lastname: finalLastname, email: finalEmail, phone: finalPhone,
        dolibarr_synced: dolibarrSynced,
      });
    } catch (err) {
      console.error('Author update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour auteur' });
    }
  });

  // POST /api/admin/authors/:id/photo — upload de la photo de profil (re-encodée, sécurisée)
  router.post('/authors/:id/photo', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, authorPhotoUpload.single('photo'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare('SELECT id, photo_url FROM authors WHERE id = ?').get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

      // 1) Validation par magic bytes
      const detected = detectImageFormat(req.file.buffer);
      if (!detected || !['jpeg', 'png', 'webp'].includes(detected)) {
        return res.status(400).json({ error: 'Format non supporté (JPG, PNG ou WEBP uniquement)' });
      }

      // 2) Re-encodage via sharp : strip EXIF + normalise + recadre en portrait carré-ish
      let safeBuffer;
      try {
        safeBuffer = await sharp(req.file.buffer, { failOn: 'error' })
          .rotate() // auto-orient avant suppression EXIF
          .resize({ width: 600, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
      } catch (encodeErr) {
        console.error('Author photo re-encode failed:', encodeErr.message);
        return res.status(400).json({ error: 'Image corrompue ou non décodable' });
      }

      const filename = `author-${id}-${Date.now()}.jpg`;
      writeFileSync(join(AUTHOR_PHOTOS_DIR, filename), safeBuffer);

      // Supprime l'ancienne photo uploadée (si c'en était une, pas une URL externe)
      const prev = author.photo_url || '';
      if (prev.startsWith('/images/authors/')) {
        try { rmSync(join(AUTHOR_PHOTOS_DIR, prev.split('/').pop()), { force: true }); } catch { /* ignore */ }
      }

      const photoUrl = `/images/authors/${filename}`;
      db.prepare('UPDATE authors SET photo_url = ? WHERE id = ?').run(photoUrl, id);
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_upload_photo', `#${id} ${filename}`);

      res.json({ success: true, photo_url: photoUrl });
    } catch (err) {
      console.error('Author photo upload error:', err.message);
      res.status(500).json({ error: 'Erreur upload photo' });
    }
  });

  // POST /api/admin/authors/:id/notify-royalties — email à l'auteur avec ses royalties dues
  router.post('/authors/:id/notify-royalties', auth, requireRoles('super_admin', 'admin', 'comptable'), csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare('SELECT id, email, firstname, lastname, dolibarr_thirdparty_id, display_name FROM authors WHERE id = ?').get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });
      if (!author.email) return res.status(400).json({ error: 'Pas d\'email pour cet auteur' });
      if (!transporter) return res.status(503).json({ error: 'SMTP non configuré' });

      // Calcul rapide royalties année courante (réplique de la logique de /royalties)
      const displayName = (author.display_name || `${author.firstname} ${author.lastname}`).trim();
      const year = new Date().getFullYear();
      const dateFrom = `${year}-01-01`;
      const dateTo = `${year}-12-31`;
      let contractWhere = '';
      let contractParams = [];
      if (author.dolibarr_thirdparty_id) {
        contractWhere = 'c.fk_soc = ?'; contractParams = [author.dolibarr_thirdparty_id];
      } else {
        contractWhere = 's.nom LIKE ?'; contractParams = [`%${displayName.replace(/[%_]/g, '')}%`];
      }
      const [contracts] = await dolibarrPool.query(
        `SELECT c.rowid AS id, c.ref, ce.book_title, ce.book_isbn, ce.contract_type,
                ce.royalty_rate_print AS rate, ce.royalty_threshold AS threshold, ce.free_author_copies AS free_copies
         FROM llx_contrat c
         JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         JOIN llx_societe s ON s.rowid = c.fk_soc
         WHERE ${contractWhere} AND c.statut >= 1 AND ce.book_isbn IS NOT NULL AND ce.book_isbn <> ''`,
        contractParams,
      );

      const rows = [];
      let totalDue = 0;
      for (const c of contracts) {
        const isbn = String(c.book_isbn || '').replace(/[-\s]/g, '');
        if (!isbn) continue;
        const [[cumRow]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(fd.qty), 0) AS units
           FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
           JOIN llx_product p ON p.rowid = fd.fk_product
           WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
             AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
             AND f.datef <= ?`,
          [isbn, dateTo],
        );
        const cumulative = Number(cumRow.units);
        const [[periodRow]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS gross
           FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
           JOIN llx_product p ON p.rowid = fd.fk_product
           WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
             AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
             AND f.datef BETWEEN ? AND ?`,
          [isbn, dateFrom, dateTo],
        );
        const unitsPeriod = Number(periodRow.units);
        if (unitsPeriod === 0) continue;
        const grossPeriod = Number(periodRow.gross);
        const rate = Number(c.rate) || 0;
        // Calcul via le module unifié (server/royalties.js) : seuil = threshold SEUL
        // (jamais +freeCopies), exemplaires gratuits déjà exclus par total_ht>0, et
        // paliers DLL gérés. Garantit l'égalité montant email = espace auteur = compta.
        const breakdown = computeRoyaltyBreakdown({
          contractType: c.contract_type,
          unitsSold: unitsPeriod,
          grossHt: grossPeriod,
          cumulativeUnits: cumulative,
          threshold: Number(c.threshold) || 0,
          rate,
          thresholdMode: 'cumulative',
        });
        const due = Math.round(breakdown.royaltyDue);
        if (due > 0) {
          rows.push({ book: c.book_title, ref: c.ref, units: unitsPeriod, rate, due });
          totalDue += due;
        }
      }

      const siteUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const tableHtml = rows.length
        ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">
            <thead><tr style="background:#f3f4f6">
              <th style="text-align:left;padding:8px;border:1px solid #e5e7eb">Livre</th>
              <th style="text-align:right;padding:8px;border:1px solid #e5e7eb">Ventes ${year}</th>
              <th style="text-align:right;padding:8px;border:1px solid #e5e7eb">Taux</th>
              <th style="text-align:right;padding:8px;border:1px solid #e5e7eb">Dû (XOF)</th>
            </tr></thead><tbody>
            ${rows.map((r) => `<tr>
              <td style="padding:8px;border:1px solid #e5e7eb">${r.book}</td>
              <td style="text-align:right;padding:8px;border:1px solid #e5e7eb">${r.units}</td>
              <td style="text-align:right;padding:8px;border:1px solid #e5e7eb">${r.rate}%</td>
              <td style="text-align:right;padding:8px;border:1px solid #e5e7eb"><strong>${r.due.toLocaleString('fr-FR')}</strong></td>
            </tr>`).join('')}
            <tr style="background:#f0fdf4"><td colspan="3" style="text-align:right;padding:8px;border:1px solid #e5e7eb"><strong>Total dû</strong></td>
              <td style="text-align:right;padding:8px;border:1px solid #e5e7eb"><strong>${totalDue.toLocaleString('fr-FR')} XOF</strong></td></tr>
          </tbody></table>`
        : '<p>Aucune royaltie due sur la période en cours (pas de ventes au-dessus du seuil).</p>';

      await transporter.sendMail({
        from: '"L\'Harmattan Sénégal — Royalties" <direction@senharmattan.com>',
        to: author.email,
        subject: `Vos royalties ${year} — L'Harmattan Sénégal`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#222">
            <h2 style="color:#10531a">Vos royalties — exercice ${year}</h2>
            <p>Bonjour ${author.firstname || ''},</p>
            <p>Voici le calcul de vos royalties sur la période en cours, basé sur les ventes enregistrées :</p>
            ${tableHtml}
            <p>Vous pouvez retrouver le détail des ventes dans votre <a href="${siteUrl}/auteur/dashboard" style="color:#10531a">espace auteur</a>.</p>
            <p style="color:#666;font-size:0.9em;margin-top:24px">L'équipe éditoriale — L'Harmattan Sénégal</p>
          </div>`,
      });

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_notify_royalties', `→ ${author.email} (${year}) ${rows.length} livres / ${totalDue} XOF`);

      res.json({ success: true, email: author.email, year, total_due: totalDue, books: rows.length });
    } catch (err) {
      console.error('Notify royalties error:', err.message);
      res.status(500).json({ error: 'Erreur envoi notification royalties' });
    }
  });

  router.post('/authors/:id/reset-password', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare('SELECT email, firstname FROM authors WHERE id = ?').get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });
      if (!author.email) return res.status(400).json({ error: 'Cet auteur n\'a pas d\'adresse email enregistrée' });

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare(
        'INSERT OR REPLACE INTO author_password_resets (email, token, expires_at) VALUES (?, ?, ?)'
      ).run(author.email, token, expires);

      const siteUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const resetLink = `${siteUrl}/auteur/mot-de-passe-oublie?token=${encodeURIComponent(token)}&email=${encodeURIComponent(author.email)}`;

      if (!transporter) {
        console.error('[RESET] Transporter SMTP indisponible');
        return res.status(503).json({ error: 'Service email non configuré' });
      }

      try {
        const info = await transporter.sendMail({
          from: '"L\'Harmattan Sénégal — Portail Auteur" <noreply@senharmattan.com>',
          to: author.email,
          subject: 'Réinitialisation de votre mot de passe auteur',
          html: `<p>Bonjour ${author.firstname || ''},</p>
                 <p>Un administrateur a demandé une réinitialisation de votre mot de passe.</p>
                 <p><a href="${resetLink}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Réinitialiser</a></p>
                 <p>Ce lien expire dans 1 heure.</p>`,
        });
        console.log(`[RESET] Email auteur envoyé à ${author.email} (messageId=${info?.messageId || '?'})`);
      } catch (mailErr) {
        console.error('[RESET] Échec envoi email auteur:', mailErr);
        db.prepare('DELETE FROM author_password_resets WHERE email = ?').run(author.email);
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin?.username || 'unknown', 'author_reset_password_failed', `Échec envoi à ${author.email}: ${mailErr.message}`);
        return res.status(502).json({ error: `Échec envoi email : ${mailErr.message}` });
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_reset_password', `Reset MDP envoyé à ${author.email}`);

      res.json({ success: true, email: author.email });
    } catch (err) {
      console.error('Author reset password error:', err);
      res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TIERS Dolibarr (llx_societe) — clients, prospects, fournisseurs
  // ═══════════════════════════════════════════════════════════

  router.get('/societes', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const { q = '', type = '', page = 1, limit = 30 } = req.query;
      const pageInt = Math.max(1, parseInt(page) || 1);
      const limitInt = Math.min(100, parseInt(limit) || 30);
      const offset = (pageInt - 1) * limitInt;

      const where = [];
      const params = [];
      if (q) {
        const pat = `%${safeLike(q)}%`;
        where.push(`(s.nom LIKE ? OR s.name_alias LIKE ? OR s.code_client LIKE ? OR s.code_fournisseur LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.zip LIKE ? OR s.town LIKE ?)`);
        params.push(pat, pat, pat, pat, pat, pat, pat, pat);
      }
      // type: 'client' | 'prospect' | 'fournisseur'
      if (type === 'client')      where.push(`s.client IN (1,3)`);
      else if (type === 'prospect')  where.push(`s.client IN (2,3)`);
      else if (type === 'fournisseur') where.push(`s.fournisseur = 1`);

      // Statut : actifs par défaut (les tiers archivés/fusionnés status=0 sont
      // masqués). 'archived' → uniquement archivés ; 'all' → tout.
      const statut = String(req.query.statut || 'active');
      if (statut === 'active') where.push(`s.status = 1`);
      else if (statut === 'archived') where.push(`s.status = 0`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [[{ n: total }]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS n FROM llx_societe s ${whereSql}`, params
      );
      const [rows] = await dolibarrPool.query(
        `SELECT s.rowid AS id, s.nom, s.name_alias, s.code_client, s.code_fournisseur,
                s.client, s.fournisseur, s.email, s.phone, s.town, s.zip, s.barcode,
                s.status, s.datec AS created_at
         FROM llx_societe s
         ${whereSql}
         ORDER BY s.nom ASC
         LIMIT ? OFFSET ?`,
        [...params, limitInt, offset]
      );

      res.json({
        societes: rows,
        total,
        page: pageInt,
        pages: Math.ceil(total / limitInt),
      });
    } catch (err) {
      console.error('Societes list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement tiers' });
    }
  });

  router.get('/societes/:id', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });

      const [[societe]] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, name_alias, code_client, code_fournisseur, client, fournisseur,
                siret, tva_intra, phone, email, town, zip, address, barcode,
                fk_typent AS typent_id, note_private, datec AS created_at
         FROM llx_societe WHERE rowid = ?`, [id]
      );
      if (!societe) return res.status(404).json({ error: 'Tiers introuvable' });

      const [invoices] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.datef AS date, f.total_ht, f.total_ttc, f.paye, f.fk_statut, f.type,
                COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
         FROM llx_facture f WHERE f.fk_soc = ? ORDER BY f.rowid DESC LIMIT 25`, [id]
      );
      const [[invoiceTotals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(total_ht), 0) AS total_ht,
                COALESCE(SUM(total_ttc), 0) AS total_ttc,
                COALESCE(SUM(CASE WHEN type <> 2 THEN paid_amount ELSE 0 END), 0) AS total_paid,
                COALESCE(SUM(CASE WHEN fk_statut = 1 AND type <> 2
                                  THEN GREATEST(total_ttc - paid_amount, 0) ELSE 0 END), 0) AS total_unpaid
         FROM (
           SELECT f.total_ht, f.total_ttc, f.fk_statut, f.type,
                  COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
           FROM llx_facture f WHERE f.fk_soc = ?
         ) t`, [id]
      );

      const [quotes] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, datep AS date, total_ht, total_ttc, fk_statut
         FROM llx_propal WHERE fk_soc = ? ORDER BY rowid DESC LIMIT 50`, [id]
      );
      const [[quoteTotals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_ht), 0) AS total_ht,
                COALESCE(SUM(total_ttc), 0) AS total_ttc
         FROM llx_propal WHERE fk_soc = ?`, [id]
      );

      // Lien éventuel avec un compte web (auto-inscrit)
      let webAccount = null;
      try {
        webAccount = db.prepare(
          `SELECT id, email, firstname, lastname, created_at FROM customers WHERE dolibarr_id = ?`
        ).get(id) || null;
      } catch (e) { void e; }

      // Lien éventuel avec une fiche auteur (tiers promu en auteur)
      let authorAccount = null;
      try {
        authorAccount = db.prepare(
          `SELECT id, display_name, slug, public_listed FROM authors WHERE dolibarr_thirdparty_id = ?`
        ).get(id) || null;
      } catch (e) { void e; }

      res.json({ societe, invoices, invoiceTotals, quotes, quoteTotals, webAccount, authorAccount });
    } catch (err) {
      console.error('Societe detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement tiers' });
    }
  });

  // POST /api/admin/societes/:id/promote-author — transforme un tiers en fiche auteur
  // Idempotent : si déjà lié (ou même email), renvoie l'auteur existant en le liant au tiers.
  router.post('/societes/:id/promote-author', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });

      const [[societe]] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, name_alias, email, phone FROM llx_societe WHERE rowid = ?`, [id]
      );
      if (!societe) return res.status(404).json({ error: 'Tiers introuvable' });

      // 1. Déjà lié à ce tiers ? → on renvoie l'auteur existant
      const linked = db.prepare(
        `SELECT id, display_name, slug FROM authors WHERE dolibarr_thirdparty_id = ?`
      ).get(id);
      if (linked) return res.status(200).json({ created: false, linked: true, ...linked });

      const fullName = String(societe.nom || societe.name_alias || '').trim();
      if (!fullName) return res.status(400).json({ error: 'Le tiers n’a pas de nom' });
      // Découpage best-effort : dernier mot = nom, le reste = prénom (display_name = nom du tiers tel quel)
      const parts = fullName.split(/\s+/);
      const lastname = parts.length > 1 ? parts[parts.length - 1] : fullName;
      const firstname = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      const email = String(societe.email || '').trim().toLowerCase();
      const phone = String(societe.phone || '').trim() || null;

      // 2. Un auteur a déjà cet email ? → on le lie à ce tiers (pas de doublon)
      if (email) {
        const byEmail = db.prepare(`SELECT id, display_name, slug FROM authors WHERE LOWER(email) = ?`).get(email);
        if (byEmail) {
          db.prepare(`UPDATE authors SET dolibarr_thirdparty_id = ?, phone = COALESCE(NULLIF(phone, ''), ?) WHERE id = ?`)
            .run(id, phone, byEmail.id);
          db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
            .run(req.admin?.username || 'unknown', 'author_link_thirdparty', `#${byEmail.id} ↔ tiers ${id} (${byEmail.display_name})`);
          return res.status(200).json({ created: false, linked: true, ...byEmail });
        }
      }

      // 3. Création de la fiche auteur liée au tiers
      const slug = generateUniqueSlug(db, fullName);
      const finalEmail = email || `auteur+${slug}@senharmattan.local`;
      const r = db.prepare(
        `INSERT INTO authors (email, password, firstname, lastname, display_name, phone, slug, dolibarr_thirdparty_id, public_listed)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, 0)`
      ).run(finalEmail, firstname, lastname, fullName, phone, slug, id);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_promote_from_tiers', `#${r.lastInsertRowid} ${fullName} (tiers=${id}, slug=${slug})`);

      res.status(201).json({ created: true, id: r.lastInsertRowid, display_name: fullName, slug });
    } catch (err) {
      console.error('Promote author error:', err.message);
      res.status(500).json({ error: 'Erreur transformation en auteur' });
    }
  });

  // Factures d'un tiers, paginées (un tiers peut en avoir des milliers)
  router.get('/societes/:id/invoices', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
      const page = Math.max(parseInt(req.query.page) || 0, 0);
      const offset = page * limit;

      const [invoices] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.datef AS date, f.total_ht, f.total_ttc, f.paye, f.fk_statut, f.type,
                COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
         FROM llx_facture f WHERE f.fk_soc = ? ORDER BY f.rowid DESC LIMIT ${limit} OFFSET ${offset}`, [id]
      );
      const [[{ total }]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total FROM llx_facture WHERE fk_soc = ?`, [id]
      );
      res.json({ invoices, total, page, limit });
    } catch (err) {
      console.error('Societe invoices error:', err.message);
      res.status(500).json({ error: 'Erreur chargement factures' });
    }
  });

  // État de compte du tiers (PDF natif : synthèse + graphes)
  router.get('/societes/:id/report.pdf', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });

      const [[societe]] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, code_client, phone, email, town, zip, address
         FROM llx_societe WHERE rowid = ?`, [id]
      );
      if (!societe) return res.status(404).json({ error: 'Tiers introuvable' });

      const [[totals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(total_ht), 0) AS total_ht,
                COALESCE(SUM(total_ttc), 0) AS total_ttc,
                COALESCE(SUM(CASE WHEN type <> 2 THEN paid_amount ELSE 0 END), 0) AS total_paid,
                COALESCE(SUM(CASE WHEN fk_statut = 1 AND type <> 2
                                  THEN GREATEST(total_ttc - paid_amount, 0) ELSE 0 END), 0) AS total_unpaid
         FROM (
           SELECT f.total_ht, f.total_ttc, f.fk_statut, f.type,
                  COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
           FROM llx_facture f WHERE f.fk_soc = ?
         ) t`, [id]
      );

      // Réglé / reste dû calculés avec la MÊME logique que la synthèse ci-dessus
      // (paiements réels, avoirs type=2 exclus, reste dû limité aux impayés) :
      // ainsi SUM(paid) == total_paid et SUM(reste) == total_unpaid, et les deux
      // blocs du PDF se réconcilient au franc près.
      const [byStatus] = await dolibarrPool.query(
        `SELECT fk_statut AS statut, COUNT(*) AS cnt,
                COALESCE(SUM(total_ttc), 0) AS ttc,
                COALESCE(SUM(CASE WHEN type <> 2 THEN paid_amount ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN fk_statut = 1 AND type <> 2
                                  THEN GREATEST(total_ttc - paid_amount, 0) ELSE 0 END), 0) AS reste
         FROM (
           SELECT f.total_ttc, f.fk_statut, f.type,
                  COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture = f.rowid), 0) AS paid_amount
           FROM llx_facture f WHERE f.fk_soc = ?
         ) t
         GROUP BY fk_statut`, [id]
      );

      const [monthlyRows] = await dolibarrPool.query(
        `SELECT DATE_FORMAT(datef, '%Y-%m') AS ym, COALESCE(SUM(total_ttc), 0) AS ttc, COUNT(*) AS cnt
         FROM llx_facture
         WHERE fk_soc = ? AND type <> 2 AND fk_statut IN (1, 2)
           AND datef >= DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL 11 MONTH), '%Y-%m-01')
         GROUP BY ym ORDER BY ym`, [id]
      );

      // Complète les 12 derniers mois (zéros inclus) pour un graphe continu.
      const byYm = new Map(monthlyRows.map(r => [r.ym, r]));
      const now = new Date();
      const monthly = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const r = byYm.get(ym);
        monthly.push({ ym, ttc: r ? Number(r.ttc) : 0, cnt: r ? Number(r.cnt) : 0 });
      }

      const pdf = buildSocieteReportPdf({ societe, totals, byStatus, monthly, generatedAt: new Date() });
      const safe = String(societe.nom || `tiers-${id}`).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="etat-compte-${safe}.pdf"`);
      res.send(pdf);
    } catch (err) {
      console.error('Societe report error:', err.message);
      res.status(500).json({ error: 'Erreur génération du rapport' });
    }
  });

  // ─── CRUD tiers (via Dolibarr REST API pour respecter la business logic) ─

  function sanitizeSocieteInput(body) {
    const data = {};
    const str = (k, max = 200) => {
      if (body[k] === undefined) return;
      data[k] = String(body[k] || '').trim().slice(0, max);
    };
    const num = (k) => {
      if (body[k] === undefined) return;
      const n = parseInt(body[k]);
      if (!isNaN(n)) data[k] = n;
    };
    str('name', 200);
    str('name_alias', 200);
    str('email', 150);
    str('phone', 30);
    str('address', 300);
    str('zip', 20);
    str('town', 100);
    str('siret', 30);
    str('tva_intra', 30);
    str('note_private', 2000);
    num('client');         // 0=non, 1=client, 2=prospect, 3=client+prospect
    num('fournisseur');    // 0/1
    // -1 = auto-générer chez Dolibarr
    if (body.code_client !== undefined) data.code_client = body.code_client === -1 || body.code_client === '-1' ? -1 : String(body.code_client).trim().slice(0, 20);
    if (body.code_fournisseur !== undefined) data.code_fournisseur = body.code_fournisseur === -1 || body.code_fournisseur === '-1' ? -1 : String(body.code_fournisseur).trim().slice(0, 20);
    return data;
  }

  router.post('/societes', auth, requireRoles('super_admin', 'admin', 'editor', 'librarian', 'comptable', 'gestionnaire_stock'), csrfProtection, async (req, res) => {
    try {
      const data = sanitizeSocieteInput(req.body);
      const firstname = String(req.body.firstname || '').trim();
      const isCompany = !!req.body.is_company;

      // Validation : nom + (prénom si particulier) + (téléphone OU email).
      const vErr = validateTierIdentity({ name: data.name, firstname, email: data.email, phone: data.phone, isCompany });
      if (vErr) return res.status(400).json({ error: vErr });

      // Dédup : si un tier actif a déjà cet email / téléphone, on n'en crée pas
      // un doublon — on informe l'admin du tiers existant (409).
      const existing = await findExistingTier(dolibarrPool, { email: data.email, phone: data.phone });
      if (existing) {
        return res.status(409).json({
          error: `Un tiers actif existe déjà avec ce ${existing.matchedBy === 'email' ? 'email' : 'téléphone'} : « ${existing.name} » (#${existing.id}).`,
          existing,
        });
      }

      // Nom combiné « Prénom NOM » + marquage particulier.
      data.name = buildTierName({ name: data.name, firstname, isCompany });
      if (!isCompany) data.typent_id = TYPENT_PARTICULIER;

      // Au moins un type doit être renseigné
      if (!data.client && !data.fournisseur) data.client = 1;

      const created = await adminApi.post('/thirdparties', data);
      const newId = created.data;

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'tier_create', `#${newId} ${data.name}`);

      res.status(201).json({ id: newId, name: data.name });
    } catch (err) {
      const dolErr = err.response?.data?.error?.message || err.response?.data?.message;
      console.error('Societe create error:', dolErr || err.message);
      if (err.response?.status === 409 || /already exists|déjà/i.test(dolErr || '')) {
        return res.status(409).json({ error: 'Un tiers avec ce nom ou ce code existe déjà' });
      }
      res.status(500).json({ error: dolErr || 'Erreur création tiers' });
    }
  });

  router.put('/societes/:id', auth, requireRoles('super_admin', 'admin', 'editor', 'librarian', 'comptable', 'gestionnaire_stock'), csrfProtection, async (req, res) => {
    // NOTE : on n'utilise PAS la REST API Dolibarr (PUT /thirdparties/{id})
    // car la base contient des code_fournisseur legacy ("SU001439") qui ne
    // respectent pas la syntaxe du module configuré (mod_codeclient_monkey,
    // attendu : "CU2501-XXXXX"). Societe::verify() retourne -3 avec
    // ErrorBadSupplierCodeSyntax, et la protection « oldcopy == newcode »
    // n'est jamais activée par l'API REST → 500 systématique.
    // Écriture SQL directe : sûre car les triggers/modules custom de ce
    // Dolibarr n'écoutent aucun événement COMPANY_*.
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });

      const data = sanitizeSocieteInput(req.body);
      // Un tiers Dolibarr n'a qu'un champ `nom`. Comme à la création, on
      // recompose « Prénom NOM » pour un particulier à partir des deux champs
      // du formulaire (firstname + name). Recombinaison sans perte.
      const firstname = String(req.body.firstname || '').trim();
      const isCompany = !!req.body.is_company;
      const natureProvided = req.body.is_company !== undefined;
      if (data.name !== undefined) {
        data.name = buildTierName({ name: data.name, firstname, isCompany });
      }
      if (data.name !== undefined && data.name.length < 2) {
        return res.status(400).json({ error: 'Nom du tiers requis (2 caractères min.)' });
      }
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        return res.status(400).json({ error: 'Email invalide' });
      }

      // Existe ?
      const [[exists]] = await dolibarrPool.query('SELECT rowid FROM llx_societe WHERE rowid = ?', [id]);
      if (!exists) return res.status(404).json({ error: 'Tiers introuvable' });

      // Mapping field → (column, nullable). On omet les champs absents pour
      // préserver les valeurs existantes ; on accepte "" pour vider une
      // colonne nullable (email, zip, town, address, etc.).
      // Toutes les colonnes texte de llx_societe sont nullable. On accepte ""
      // pour vider (=> NULL), sauf `nom` qui reste requis (longueur ≥ 2
      // validée plus haut).
      const stringCols = {
        name:         { col: 'nom',          nullable: false },
        name_alias:   { col: 'name_alias',   nullable: true },
        email:        { col: 'email',        nullable: true },
        phone:        { col: 'phone',        nullable: true },
        address:      { col: 'address',      nullable: true },
        zip:          { col: 'zip',          nullable: true },
        town:         { col: 'town',         nullable: true },
        siret:        { col: 'siret',        nullable: true },
        tva_intra:    { col: 'tva_intra',    nullable: true },
        note_private: { col: 'note_private', nullable: true },
      };
      const intCols = {
        client: 'client',
        fournisseur: 'fournisseur',
      };
      const codeCols = {
        code_client: 'code_client',
        code_fournisseur: 'code_fournisseur',
      };

      const sets = [];
      const params = [];
      for (const [key, { col, nullable }] of Object.entries(stringCols)) {
        if (data[key] === undefined) continue;
        const v = String(data[key]);
        if (v === '' && nullable) { sets.push(`${col} = NULL`); continue; }
        sets.push(`${col} = ?`); params.push(v);
      }
      for (const [key, col] of Object.entries(intCols)) {
        if (data[key] === undefined) continue;
        sets.push(`${col} = ?`); params.push(parseInt(data[key]) || 0);
      }
      for (const [key, col] of Object.entries(codeCols)) {
        if (data[key] === undefined) continue;
        // -1 = "garder l'auto-génération" — on n'écrit rien
        if (data[key] === -1 || data[key] === '-1') continue;
        const v = String(data[key]);
        if (v === '') { sets.push(`${col} = NULL`); continue; }
        sets.push(`${col} = ?`); params.push(v);
      }

      // Nature (particulier/entreprise) → fk_typent, uniquement si le
      // formulaire l'a explicitement transmise. Permet d'assainir au fil de
      // l'eau les tiers sans type (NULL).
      if (natureProvided) {
        if (isCompany) { sets.push('fk_typent = NULL'); }
        else { sets.push('fk_typent = ?'); params.push(TYPENT_PARTICULIER); }
      }

      if (sets.length === 0) return res.json({ success: true, id, noop: true });

      sets.push('tms = CURRENT_TIMESTAMP');
      params.push(id);
      await dolibarrPool.query(`UPDATE llx_societe SET ${sets.join(', ')} WHERE rowid = ?`, params);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'tier_update', `#${id} (direct SQL)`);

      res.json({ success: true, id });
    } catch (err) {
      console.error('Societe update error:', err.code, err.sqlMessage || err.message);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Doublon : un autre tiers utilise déjà ce code/nom' });
      }
      res.status(500).json({ error: err.sqlMessage || 'Erreur mise à jour tiers' });
    }
  });

  router.delete('/societes/:id', auth, requireRoles('super_admin', 'admin'), csrfProtection, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Id invalide' });

      // Garde-fou : refuser la suppression si le tiers a des factures, devis ou contrats
      const [[invCount]] = await dolibarrPool.query('SELECT COUNT(*) AS n FROM llx_facture WHERE fk_soc = ?', [id]);
      const [[propCount]] = await dolibarrPool.query('SELECT COUNT(*) AS n FROM llx_propal WHERE fk_soc = ?', [id]);
      const [[contCount]] = await dolibarrPool.query('SELECT COUNT(*) AS n FROM llx_contrat WHERE fk_soc = ?', [id]);
      const blockers = [];
      if (invCount.n > 0) blockers.push(`${invCount.n} facture${invCount.n > 1 ? 's' : ''}`);
      if (propCount.n > 0) blockers.push(`${propCount.n} devis`);
      if (contCount.n > 0) blockers.push(`${contCount.n} contrat${contCount.n > 1 ? 's' : ''}`);
      if (blockers.length > 0) {
        return res.status(409).json({
          error: `Suppression refusée — ce tiers est lié à : ${blockers.join(', ')}.`,
        });
      }

      // Récupère le nom pour le log avant suppression
      const [[soc]] = await dolibarrPool.query('SELECT nom FROM llx_societe WHERE rowid = ?', [id]);
      if (!soc) return res.status(404).json({ error: 'Tiers introuvable' });

      await adminApi.delete(`/thirdparties/${id}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'tier_delete', `#${id} ${soc.nom}`);

      res.json({ success: true });
    } catch (err) {
      const dolErr = err.response?.data?.error?.message || err.response?.data?.message;
      console.error('Societe delete error:', dolErr || err.message);
      if (err.response?.status === 404) return res.status(404).json({ error: 'Tiers introuvable' });
      res.status(500).json({ error: dolErr || 'Erreur suppression tiers' });
    }
  });

  // ─── PDF devis (via endpoint PHP custom Dolibarr) ─────────
  router.get('/propals/:id/pdf', auth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id invalide' });
    if (!DOLIBARR_WEBHOOK_SECRET) {
      return res.status(500).json({ error: 'DOLIBARR_WEBHOOK_SECRET non configuré' });
    }
    try {
      const phpRes = await axios.post(
        DOC_BUILDDOC_URL,
        { type: 'propal', id },
        {
          headers: { 'X-Dolibarr-Secret': DOLIBARR_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer',
          timeout: 30000,
          validateStatus: () => true,
        }
      );
      const buf = Buffer.from(phpRes.data);
      const isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
      const isZip = buf[0] === 0x50 && buf[1] === 0x4B; // 'PK' = conteneur ODT/zip
      if (phpRes.status >= 200 && phpRes.status < 300 && (isPdf || isZip)) {
        // Le modèle de devis sort de l'ODT → on convertit en PDF à la volée.
        let pdf;
        try {
          pdf = isPdf ? buf : odtBufferToPdf(buf);
        } catch (convErr) {
          console.error('[PROPAL /pdf] conversion ODT→PDF échouée:', convErr.message);
          return res.status(500).json({ error: 'Conversion du devis en PDF échouée' });
        }
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="devis-${id}.pdf"`);
        return res.send(pdf);
      }
      let detail = 'Erreur génération PDF';
      try {
        const json = JSON.parse(Buffer.from(phpRes.data).toString());
        detail = json.error || detail;
        console.warn('[PROPAL /pdf] php endpoint error:', json);
      } catch { void 0; }
      return res.status(phpRes.status || 500).json({ error: detail });
    } catch (err) {
      console.error('[PROPAL /pdf] exception:', err.message);
      res.status(500).json({ error: 'Erreur téléchargement PDF devis', detail: err.message });
    }
  });

  return router;
}
