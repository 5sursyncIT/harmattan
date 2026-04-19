import { Router } from 'express';
import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

/**
 * Customer authentication routes module
 * Extracted from index.js for maintainability
 */
export function createAuthRouter({ db, csrfProtection, sanitizeBody, authLimiter, requireCustomerAuth, dolibarrApi, transporter, cookieSecure }) {
  const router = Router();

  // Login
  router.post('/login', authLimiter, csrfProtection, sanitizeBody(['email']), async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

      const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
      if (!customer) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      const valid = await bcrypt.compare(password, customer.password);
      if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      // Create server-side session
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO customer_sessions (token, customer_id, expires_at) VALUES (?, ?, ?)').run(sessionToken, customer.id, expiresAt);
      res.cookie('customer_session', sessionToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure: cookieSecure,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        id: customer.dolibarr_id,
        name: `${customer.firstname} ${customer.lastname}`,
        firstname: customer.firstname,
        lastname: customer.lastname,
        email: customer.email,
        phone: customer.phone || '',
        address: customer.address || '',
        town: customer.city || 'Dakar',
      });
    } catch (err) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'Erreur de connexion' });
    }
  });

  // Register
  router.post('/register', authLimiter, csrfProtection, sanitizeBody(['email', 'firstname', 'lastname', 'phone']), async (req, res) => {
    try {
      const { email, password, firstname, lastname, phone } = req.body;
      if (!email || !password || !firstname || !lastname) {
        return res.status(400).json({ error: 'Tous les champs obligatoires doivent être remplis' });
      }
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }

      const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
      if (existing) return res.status(400).json({ error: 'Un compte existe déjà avec cet email' });

      // Create in Dolibarr
      let dolibarrId = null;
      try {
        const doliRes = await dolibarrApi.post('/thirdparties', {
          name: `${firstname} ${lastname}`,
          email,
          phone: phone || '',
          client: 1,
          code_client: -1,
        });
        dolibarrId = doliRes.data;
      } catch (err) {
        console.error('Dolibarr customer creation error:', err.response?.data || err.message);
      }

      const hash = await bcrypt.hash(password, 12);
      db.prepare(
        'INSERT INTO customers (email, password, firstname, lastname, phone, dolibarr_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(email, hash, firstname, lastname, phone || null, dolibarrId);

      res.json({ success: true, dolibarr_id: dolibarrId });
    } catch (err) {
      console.error('Register error:', err.message);
      res.status(500).json({ error: 'Erreur lors de la création du compte' });
    }
  });

  // Forgot password
  router.post('/forgot-password', authLimiter, csrfProtection, sanitizeBody(['email']), async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });

      const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
      if (!customer) return res.json({ success: true }); // anti-enumeration

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
        email TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at DATETIME NOT NULL
      )`);
      db.prepare('INSERT OR REPLACE INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)').run(email, token, expiresAt);

      const baseUrl = process.env.SITE_URL || 'http://38.242.229.122:3000';
      const resetUrl = `${baseUrl}/reinitialiser-mdp?token=${token}&email=${encodeURIComponent(email)}`;
      transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
        to: email,
        subject: 'Réinitialisation de votre mot de passe',
        html: `<p>Bonjour,</p><p>Vous avez demandé la réinitialisation de votre mot de passe.</p><p><a href="${resetUrl}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Réinitialiser mon mot de passe</a></p><p>Ce lien expire dans 1 heure.</p><p>Si vous n'avez pas fait cette demande, ignorez cet email.</p><p>L'équipe L'Harmattan Sénégal</p>`,
      }).catch((err) => console.error('[AUTH] Reset email error:', err.message));

      res.json({ success: true });
    } catch (err) {
      console.error('Forgot password error:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // Reset password
  router.post('/reset-password', authLimiter, csrfProtection, async (req, res) => {
    try {
      const { email, token, password } = req.body;
      if (!email || !token || !password) return res.status(400).json({ error: 'Tous les champs sont requis' });
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }

      db.exec(`CREATE TABLE IF NOT EXISTS password_resets (email TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at DATETIME NOT NULL)`);
      const reset = db.prepare("SELECT * FROM password_resets WHERE email = ? AND token = ? AND expires_at > datetime('now')").get(email, token);
      if (!reset) return res.status(400).json({ error: 'Lien expiré ou invalide. Veuillez refaire une demande.' });

      const hash = await bcrypt.hash(password, 12);
      db.prepare('UPDATE customers SET password = ? WHERE email = ?').run(hash, email);
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);

      res.json({ success: true });
    } catch (err) {
      console.error('Reset password error:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // Update profile
  router.put('/profile', authLimiter, requireCustomerAuth, csrfProtection, sanitizeBody(['firstname', 'lastname', 'email', 'phone', 'address', 'city']), async (req, res) => {
    try {
      const { firstname, lastname, email, phone, address, city } = req.body;
      const customerId = req.customer.dolibarr_id;

      // Update Dolibarr
      if (customerId) {
        try {
          await dolibarrApi.put(`/thirdparties/${customerId}`, { name: `${firstname} ${lastname}`, email, phone, address, town: city });
        } catch (err) {
          console.error('Dolibarr profile update error:', err.message);
        }
      }

      // Update local
      db.prepare('UPDATE customers SET firstname = ?, lastname = ?, email = ?, phone = ?, address = ?, city = ? WHERE id = ?')
        .run(firstname, lastname, email, phone || null, address || null, city || 'Dakar', req.customer.id);

      res.json({ success: true });
    } catch (err) {
      console.error('Profile update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour profil' });
    }
  });

  // Change password
  router.put('/password', authLimiter, requireCustomerAuth, csrfProtection, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Tous les champs sont requis' });
      if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }

      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
      const valid = await bcrypt.compare(currentPassword, customer.password);
      if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });

      const hash = await bcrypt.hash(newPassword, 12);
      db.prepare('UPDATE customers SET password = ? WHERE id = ?').run(hash, customer.id);
      res.json({ success: true });
    } catch (err) {
      console.error('Password change error:', err.message);
      res.status(500).json({ error: 'Erreur changement mot de passe' });
    }
  });

  return router;
}
