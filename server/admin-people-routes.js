// Admin "people" management — e-commerce customers + portal authors.
// Read-only listing + detail views + password reset for both.
// Panel admin dashboard consumes these endpoints.
import { Router } from 'express';
import crypto from 'crypto';

export function createAdminPeopleRouter({ db, dolibarrPool, auth, csrfProtection, transporter }) {
  const router = Router();

  function safeLike(q) {
    return String(q || '').replace(/[%_\\]/g, '\\$&').slice(0, 100);
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

  // Reset password → envoie email de réinitialisation (réutilise table customer_password_resets si existe,
  // sinon crée la table et génère le token). Le reset lui-même se fait via /mot-de-passe-oublie
  router.post('/customers/:id/reset-password', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const customer = db.prepare('SELECT email, firstname FROM customers WHERE id = ?').get(id);
      if (!customer) return res.status(404).json({ error: 'Client introuvable' });

      db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
        email TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at DATETIME NOT NULL
      )`);

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare('INSERT OR REPLACE INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)')
        .run(customer.email, token, expires);

      const siteUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const resetLink = `${siteUrl}/mot-de-passe-oublie?token=${encodeURIComponent(token)}&email=${encodeURIComponent(customer.email)}`;

      if (transporter) {
        try {
          await transporter.sendMail({
            from: '"L\'Harmattan Sénégal" <direction@senharmattan.com>',
            to: customer.email,
            subject: 'Réinitialisation de votre mot de passe',
            html: `<p>Bonjour ${customer.firstname || ''},</p>
                   <p>Un administrateur a demandé une réinitialisation de votre mot de passe.</p>
                   <p><a href="${resetLink}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Réinitialiser</a></p>
                   <p>Ce lien expire dans 1 heure.</p>`,
          });
        } catch (mailErr) {
          console.error('Customer reset mail error:', mailErr.message);
        }
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'customer_reset_password', `Reset MDP envoyé à ${customer.email}`);

      res.json({ success: true, email: customer.email });
    } catch (err) {
      console.error('Customer reset password error:', err.message);
      res.status(500).json({ error: 'Erreur envoi email de réinitialisation' });
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
                a.email_verified, a.created_at,
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
        `SELECT id, email, firstname, lastname, phone, dolibarr_thirdparty_id, email_verified, created_at
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

  router.post('/authors/:id/reset-password', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const author = db.prepare('SELECT email, firstname FROM authors WHERE id = ?').get(id);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare(
        'INSERT OR REPLACE INTO author_password_resets (email, token, expires_at) VALUES (?, ?, ?)'
      ).run(author.email, token, expires);

      const siteUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const resetLink = `${siteUrl}/auteur/mot-de-passe-oublie?token=${encodeURIComponent(token)}&email=${encodeURIComponent(author.email)}`;

      if (transporter) {
        try {
          await transporter.sendMail({
            from: '"L\'Harmattan Sénégal — Portail Auteur" <direction@senharmattan.com>',
            to: author.email,
            subject: 'Réinitialisation de votre mot de passe auteur',
            html: `<p>Bonjour ${author.firstname || ''},</p>
                   <p>Un administrateur a demandé une réinitialisation de votre mot de passe.</p>
                   <p><a href="${resetLink}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Réinitialiser</a></p>
                   <p>Ce lien expire dans 1 heure.</p>`,
          });
        } catch (mailErr) {
          console.error('Author reset mail error:', mailErr.message);
        }
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'author_reset_password', `Reset MDP envoyé à ${author.email}`);

      res.json({ success: true, email: author.email });
    } catch (err) {
      console.error('Author reset password error:', err.message);
      res.status(500).json({ error: 'Erreur envoi email de réinitialisation' });
    }
  });

  return router;
}
