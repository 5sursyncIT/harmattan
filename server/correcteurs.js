import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Liste des correcteurs (relecteurs) habilités à être affectés à un manuscrit.
// Ce sont des intervenants externes notifiés par email. Pour s'intégrer au
// workflow manuscrit existant (qui affecte des `admin_users` par rôle), ils sont
// enregistrés comme comptes `admin_users` de rôle « correcteur » MAIS désactivés
// (is_active = 0) avec un mot de passe aléatoire : ils ne peuvent jamais se
// connecter, seulement être affectés et notifiés.
// Pour ajouter / retirer un correcteur : éditer ce tableau puis redémarrer le
// service (le seed est idempotent). Le `name` sert d'identifiant d'affichage.
export const CORRECTEURS = [
  { id: 'sada-kane',     name: 'Sada Kane',      email: 'alaska11.kane@gmail.com' },
  { id: 'celia-sanchez', name: 'Célia Sanchez',  email: 'celiasanchez4@gmail.com' },
  { id: 'magueye-toure', name: 'Maguèye Touré',  email: 'catontoure@yahoo.fr' },
  { id: 'bemba-konate',  name: 'Bemba Konaté',   email: 'konatebemba@gmail.com' },
];

// Crée / met à jour les correcteurs comme intervenants non-connectables.
// Idempotent : insère ceux qui manquent, met à jour l'email d'un correcteur
// existant (matché par username = name) sans toucher aux comptes admin réels.
export function seedCorrecteurs(db) {
  const findByUsername = db.prepare('SELECT id, role, email FROM admin_users WHERE username = ?');
  const insert = db.prepare(
    "INSERT INTO admin_users (username, password, role, email, is_active) VALUES (?, ?, 'correcteur', ?, 0)"
  );
  const updateEmail = db.prepare('UPDATE admin_users SET email = ? WHERE id = ?');
  for (const c of CORRECTEURS) {
    const existing = findByUsername.get(c.name);
    if (!existing) {
      // Mot de passe aléatoire jamais communiqué → connexion impossible (is_active=0 de toute façon).
      const pwd = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
      insert.run(c.name, pwd, c.email);
    } else if (existing.role === 'correcteur' && existing.email !== c.email) {
      updateEmail.run(c.email, existing.id);
    }
  }
}
