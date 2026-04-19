/**
 * Routes admin pour la gestion du POS.
 * Accès : session admin (pas besoin du token POS).
 *
 * Couvre :
 *  - Appareils POS (list, generate-code, revoke, reactivate)
 *  - Personnel POS (list, create, update, reset PIN, deactivate)
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export function createAdminPosRouter({ db, auth, csrfProtection }) {
  const router = Router();

  // ══════════════════════════════════════════════════════════
  // APPAREILS POS
  // ══════════════════════════════════════════════════════════

  // GET /api/admin/pos/devices — Liste tous les appareils
  router.get('/devices', auth, (req, res) => {
    const devices = db.prepare(
      `SELECT id, device_name, last_seen_at, last_ip, active, created_at
       FROM pos_devices ORDER BY created_at DESC`
    ).all();
    res.json(devices);
  });

  // POST /api/admin/pos/devices/generate-code — Générer un code d'enrôlement
  router.post('/devices/generate-code', auth, csrfProtection, (req, res) => {
    try {
      const { device_name } = req.body || {};
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      db.prepare(
        'INSERT INTO pos_enrollment_codes (code, created_by, device_name, expires_at) VALUES (?, ?, ?, ?)'
      ).run(code, null, device_name || 'Nouveau POS', expiresAt);

      res.json({
        code,
        expires_in: 600,
        device_name: device_name || 'Nouveau POS',
        expires_at: expiresAt,
      });
    } catch (err) {
      console.error('Admin generate code error:', err.message);
      res.status(500).json({ error: 'Erreur génération code' });
    }
  });

  // GET /api/admin/pos/devices/enrollment-codes — Liste codes actifs
  router.get('/devices/enrollment-codes', auth, (req, res) => {
    const codes = db.prepare(
      `SELECT code, device_name, expires_at, used, created_by
       FROM pos_enrollment_codes
       WHERE used = 0 AND expires_at > datetime('now')
       ORDER BY expires_at DESC`
    ).all();
    res.json(codes);
  });

  // PUT /api/admin/pos/devices/:id — Activer/désactiver un appareil
  router.put('/devices/:id', auth, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { active, device_name } = req.body || {};

      const device = db.prepare('SELECT id FROM pos_devices WHERE id = ?').get(id);
      if (!device) return res.status(404).json({ error: 'Appareil introuvable' });

      const updates = [];
      const values = [];
      if (typeof active !== 'undefined') {
        updates.push('active = ?');
        values.push(active ? 1 : 0);
      }
      if (device_name && device_name.trim()) {
        updates.push('device_name = ?');
        values.push(device_name.trim());
      }
      if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

      values.push(id);
      db.prepare(`UPDATE pos_devices SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare(
        'SELECT id, device_name, last_seen_at, last_ip, active, created_at FROM pos_devices WHERE id = ?'
      ).get(id);
      res.json(updated);
    } catch (err) {
      console.error('Admin update device error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour appareil' });
    }
  });

  // DELETE /api/admin/pos/devices/:id — Révoquer un appareil (soft)
  router.delete('/devices/:id', auth, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const result = db.prepare('UPDATE pos_devices SET active = 0 WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Appareil introuvable' });
    // Invalidate any active sessions from this device (via staff sessions)
    res.json({ success: true });
  });

  // ══════════════════════════════════════════════════════════
  // PERSONNEL POS
  // ══════════════════════════════════════════════════════════

  // GET /api/admin/pos/staff — Liste tout le personnel
  router.get('/staff', auth, (req, res) => {
    const staff = db.prepare(
      `SELECT id, name, role, active, created_at, pin_expires_at
       FROM pos_staff ORDER BY name ASC`
    ).all();
    res.json(staff);
  });

  // POST /api/admin/pos/staff — Créer un nouveau membre du personnel
  router.post('/staff', auth, csrfProtection, (req, res) => {
    try {
      const { name, pin, role = 'cashier' } = req.body || {};

      if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est requis' });
      if (!pin || !/^\d{4,6}$/.test(String(pin))) {
        return res.status(400).json({ error: 'Le PIN doit contenir entre 4 et 6 chiffres' });
      }
      if (!['cashier', 'manager'].includes(role)) {
        return res.status(400).json({ error: 'Rôle invalide (cashier ou manager)' });
      }

      // Vérifier que le PIN n'est pas déjà utilisé (le login se base sur bcrypt compareSync sur tous les PIN actifs)
      const staffList = db.prepare('SELECT pin FROM pos_staff WHERE active = 1').all();
      for (const s of staffList) {
        if (bcrypt.compareSync(String(pin), s.pin)) {
          return res.status(400).json({ error: 'Ce code PIN est déjà utilisé par un autre membre du personnel' });
        }
      }

      const hash = bcrypt.hashSync(String(pin), 10);
      const pinExpiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

      const result = db.prepare(
        'INSERT INTO pos_staff (name, pin, role, active, pin_expires_at) VALUES (?, ?, ?, 1, ?)'
      ).run(name.trim(), hash, role, pinExpiresAt);

      res.status(201).json({
        id: result.lastInsertRowid,
        name: name.trim(),
        role,
        active: 1,
        pin_expires_at: pinExpiresAt,
      });
    } catch (err) {
      console.error('Admin create staff error:', err.message);
      res.status(500).json({ error: 'Erreur création personnel' });
    }
  });

  // PUT /api/admin/pos/staff/:id — Modifier nom, rôle, actif
  router.put('/staff/:id', auth, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { name, role, active } = req.body || {};

      const target = db.prepare('SELECT id FROM pos_staff WHERE id = ?').get(id);
      if (!target) return res.status(404).json({ error: 'Personnel introuvable' });

      const updates = [];
      const values = [];
      if (name && name.trim()) { updates.push('name = ?'); values.push(name.trim()); }
      if (role && ['cashier', 'manager'].includes(role)) { updates.push('role = ?'); values.push(role); }
      if (typeof active !== 'undefined') { updates.push('active = ?'); values.push(active ? 1 : 0); }

      if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

      values.push(id);
      db.prepare(`UPDATE pos_staff SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      // Invalider les sessions actives si désactivé
      if (typeof active !== 'undefined' && !active) {
        db.prepare('DELETE FROM pos_sessions WHERE staff_id = ?').run(id);
      }

      const updated = db.prepare(
        'SELECT id, name, role, active, created_at, pin_expires_at FROM pos_staff WHERE id = ?'
      ).get(id);
      res.json(updated);
    } catch (err) {
      console.error('Admin update staff error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour personnel' });
    }
  });

  // PUT /api/admin/pos/staff/:id/pin — Réinitialiser le PIN
  router.put('/staff/:id/pin', auth, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { pin } = req.body || {};

      if (!pin || !/^\d{4,6}$/.test(String(pin))) {
        return res.status(400).json({ error: 'Le PIN doit contenir entre 4 et 6 chiffres' });
      }

      const target = db.prepare('SELECT id FROM pos_staff WHERE id = ?').get(id);
      if (!target) return res.status(404).json({ error: 'Personnel introuvable' });

      // Vérifier unicité (en excluant l'utilisateur courant)
      const others = db.prepare('SELECT id, pin FROM pos_staff WHERE active = 1 AND id != ?').all(id);
      for (const s of others) {
        if (bcrypt.compareSync(String(pin), s.pin)) {
          return res.status(400).json({ error: 'Ce code PIN est déjà utilisé par un autre membre du personnel' });
        }
      }

      const hash = bcrypt.hashSync(String(pin), 10);
      const pinExpiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare('UPDATE pos_staff SET pin = ?, pin_expires_at = ? WHERE id = ?')
        .run(hash, pinExpiresAt, id);

      // Invalider les sessions actives
      db.prepare('DELETE FROM pos_sessions WHERE staff_id = ?').run(id);

      res.json({ success: true, pin_expires_at: pinExpiresAt });
    } catch (err) {
      console.error('Admin reset PIN error:', err.message);
      res.status(500).json({ error: 'Erreur réinitialisation PIN' });
    }
  });

  // DELETE /api/admin/pos/staff/:id — Désactiver (soft)
  router.delete('/staff/:id', auth, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const result = db.prepare('UPDATE pos_staff SET active = 0 WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Personnel introuvable' });
    db.prepare('DELETE FROM pos_sessions WHERE staff_id = ?').run(id);
    res.json({ success: true });
  });

  // ══════════════════════════════════════════════════════════
  // SESSIONS POS ACTIVES
  // ══════════════════════════════════════════════════════════

  // GET /api/admin/pos/sessions — Sessions POS actives
  router.get('/sessions', auth, (req, res) => {
    const sessions = db.prepare(
      `SELECT ps.token, ps.created_at, ps.expires_at, s.name, s.role
       FROM pos_sessions ps
       JOIN pos_staff s ON s.id = ps.staff_id
       WHERE ps.expires_at > datetime('now')
       ORDER BY ps.created_at DESC`
    ).all();
    // Masquer le token complet, ne garder que les 8 premiers caractères
    res.json(sessions.map((s) => ({ ...s, token: s.token.slice(0, 8) + '…' })));
  });

  return router;
}
