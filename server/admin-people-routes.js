// Admin "people" management — e-commerce customers + portal authors.
// Read-only listing + detail views + password reset for both.
// Panel admin dashboard consumes these endpoints.
import { Router } from 'express';
import crypto from 'crypto';
import { slugify, generateUniqueSlug } from './author-public-routes.js';

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

      // Factures Dolibarr si dolibarr_id est renseigné
      let invoices = [];
      let invoiceTotals = { count: 0, total_ht: 0, total_ttc: 0 };
      if (customer.dolibarr_id && dolibarrPool) {
        try {
          const [rows] = await dolibarrPool.query(
            `SELECT rowid AS id, facnumber AS ref, datef AS date, total_ht, total_ttc, paye, fk_statut
             FROM llx_facture WHERE fk_soc = ? ORDER BY rowid DESC LIMIT 20`,
            [customer.dolibarr_id]
          );
          invoices = rows;
          const [[totals]] = await dolibarrPool.query(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total_ht), 0) AS total_ht,
                    COALESCE(SUM(total_ttc), 0) AS total_ttc
             FROM llx_facture WHERE fk_soc = ?`,
            [customer.dolibarr_id]
          );
          invoiceTotals = totals;
        } catch (dolErr) {
          console.warn('Customer invoice fetch warning:', dolErr.message);
        }
      }

      res.json({ customer, preorders, payments, invoices, invoiceTotals });
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
  router.post('/customers/:id/reset-password', auth, requireRoles('super_admin', 'admin', 'support'), csrfProtection, async (req, res) => {
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
  router.put('/authors/:id', auth, requireRoles('super_admin', 'admin', 'editor'), csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare('SELECT id, firstname, lastname, slug FROM authors WHERE id = ?').get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });

      const {
        display_name, bio, photo_url, website,
        social_twitter, social_instagram, social_linkedin, social_facebook,
        public_listed, slug: customSlug,
      } = req.body;

      // Slug : si fourni explicitement, on l'utilise (unique). Sinon, dérivé du display_name.
      let finalSlug = author.slug;
      let finalDisplay = display_name && String(display_name).trim()
        ? String(display_name).trim()
        : `${author.firstname} ${author.lastname}`.trim();

      const desiredSlug = customSlug ? slugify(customSlug) : (author.slug || slugify(finalDisplay));
      if (desiredSlug && desiredSlug !== author.slug) {
        finalSlug = generateUniqueSlug(db, desiredSlug, id);
      } else if (!author.slug) {
        finalSlug = generateUniqueSlug(db, finalDisplay, id);
      }

      db.prepare(
        `UPDATE authors SET
           display_name = ?, slug = ?, bio = ?, photo_url = ?, website = ?,
           social_twitter = ?, social_instagram = ?, social_linkedin = ?, social_facebook = ?,
           public_listed = ?
         WHERE id = ?`
      ).run(
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

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_update_public_profile', `#${id} ${finalDisplay} (slug=${finalSlug}, public=${public_listed ? 1 : 0})`);

      res.json({ success: true, id, slug: finalSlug, display_name: finalDisplay });
    } catch (err) {
      console.error('Author update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour auteur' });
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
        `SELECT c.rowid AS id, c.ref, ce.book_title, ce.book_isbn,
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
           WHERE f.fk_statut >= 1 AND fd.qty > 0
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
           WHERE f.fk_statut >= 1 AND fd.qty > 0
             AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
             AND f.datef BETWEEN ? AND ?`,
          [isbn, dateFrom, dateTo],
        );
        const unitsPeriod = Number(periodRow.units);
        if (unitsPeriod === 0) continue;
        const grossPeriod = Number(periodRow.gross);
        const threshold = Number(c.threshold) || 0;
        const freeCopies = Number(c.free_copies) || 0;
        const rate = Number(c.rate) || 0;
        const cumBefore = cumulative - unitsPeriod;
        const thresholdPlusFree = threshold + freeCopies;
        let unitsOver = 0;
        if (cumulative > thresholdPlusFree) {
          unitsOver = cumBefore >= thresholdPlusFree ? unitsPeriod : (cumulative - thresholdPlusFree);
        }
        const avgHt = unitsPeriod > 0 ? grossPeriod / unitsPeriod : 0;
        const due = Math.round(unitsOver * avgHt * (rate / 100));
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

  return router;
}
