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

// Rôles autorisés à GÉRER les contrats, cycle de vie complet inclus (clôture,
// suppression, envoi en signature, export CSV). Le comptable en fait désormais
// partie, au même titre que les profils éditoriaux.
export const CONTRACT_EDIT_ROLES = ['super_admin', 'admin', 'editor', 'comptable'];

// Création + modification d'un contrat, et validation + téléchargement du PDF :
// mêmes profils que ci-dessus (CRUD complet).
export const CONTRACT_WRITE_ROLES = CONTRACT_EDIT_ROLES;
export const CONTRACT_VALIDATE_ROLES = CONTRACT_EDIT_ROLES;

// Rôles autorisés à ROUVRIR un contrat validé en brouillon (correction d'erreur
// détectée après validation). Action exceptionnelle réservée aux seuls
// administrateurs — ni éditeur, ni comptable.
export const CONTRACT_REOPEN_ROLES = ['super_admin', 'admin'];
