import { useState, useEffect } from 'react';
import { adminMe } from '../api/admin';

// Cache module-level : le rôle ne change pas pendant une session, on évite donc
// de rappeler /admin/me dans chaque panel qui en a besoin.
let cachedRole = null;

export default function useAdminRole() {
  const [role, setRole] = useState(cachedRole);

  useEffect(() => {
    if (cachedRole) { setRole(cachedRole); return; }
    let cancelled = false;
    adminMe()
      .then((r) => {
        cachedRole = r.data?.role || 'admin';
        if (!cancelled) setRole(cachedRole);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return role;
}

// Rôles autorisés aux actions de CYCLE DE VIE SENSIBLES d'un contrat (clôture,
// suppression, envoi en signature, export CSV). Le comptable n'en fait pas partie.
export const CONTRACT_EDIT_ROLES = ['super_admin', 'admin', 'editor'];

// Rôles autorisés à CRÉER et MODIFIER un contrat (création + édition des champs
// d'un brouillon). Inclut le comptable, en plus des profils éditoriaux.
export const CONTRACT_WRITE_ROLES = [...CONTRACT_EDIT_ROLES, 'comptable'];

// Rôles autorisés à VALIDER un contrat et TÉLÉCHARGER son PDF. Inclut le comptable.
export const CONTRACT_VALIDATE_ROLES = [...CONTRACT_EDIT_ROLES, 'comptable'];
