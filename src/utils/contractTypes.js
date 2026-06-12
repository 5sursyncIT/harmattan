// Types de contrats — source unique côté frontend.
// ⚠️ DOIT rester aligné sur server/contract-routes.js (CONTRACT_MODELS / RIGHTS_SCOPES).
// Un contrat = un modèle (cadre éditorial) × un périmètre de droits cédés.
// contract_type stocké = `${model}_${scope}` (ex. harmattan_dll_edition_complete).

export const CONTRACT_MODELS = {
  harmattan_2024: 'Harmattan · classique',
  harmattan_dll: 'Harmattan · DLL',
  tamarinier: 'Le Tamarinier',
};

export const CONTRACT_MODEL_COLORS = {
  harmattan_2024: '#10531a',
  harmattan_dll: '#0284c7',
  tamarinier: '#7c3aed',
};

export const RIGHTS_SCOPES = {
  edition_simple: 'papier seul',
  edition_numerique: 'papier + numérique',
  edition_complete: 'complète',
};

// Libellés complets des 9 types combinés actifs : « Modèle · périmètre »
export const CONTRACT_TYPE_LABELS = Object.fromEntries(
  Object.entries(CONTRACT_MODELS).flatMap(([model, modelLabel]) =>
    Object.entries(RIGHTS_SCOPES).map(([scope, scopeLabel]) => [
      `${model}_${scope}`,
      `${modelLabel} · ${scopeLabel}`,
    ])
  )
);

// Anciens types (contrats créés avant la combinaison modèle × périmètre)
Object.assign(CONTRACT_TYPE_LABELS, {
  harmattan_2024: 'Harmattan classique',
  harmattan_dll: 'Harmattan DLL',
  tamarinier: 'Le Tamarinier',
  edition_simple: 'Édition · papier',
  edition_numerique: 'Édition · papier & numérique',
  edition_complete: 'Édition · complète',
});

// Libellé d'affichage robuste : combiné, legacy, ou repli lisible.
export function contractTypeLabel(type) {
  if (!type) return '';
  return CONTRACT_TYPE_LABELS[type] || type;
}

export function contractTypeColor(type) {
  const model = Object.keys(CONTRACT_MODEL_COLORS).find(m => String(type || '').startsWith(m));
  return CONTRACT_MODEL_COLORS[model] || '#10531a';
}

// Options de filtre groupées par modèle (pour <optgroup>), uniquement les types actifs.
export const CONTRACT_TYPE_FILTER_GROUPS = Object.entries(CONTRACT_MODELS).map(
  ([model, modelLabel]) => ({
    model,
    label: modelLabel,
    options: Object.entries(RIGHTS_SCOPES).map(([scope, scopeLabel]) => ({
      value: `${model}_${scope}`,
      label: scopeLabel,
    })),
  })
);

// Statuts Dolibarr d'un contrat (llx_contrat.statut).
export const CONTRACT_STATUS_LABELS = { 0: 'Brouillon', 1: 'Actif', 2: 'Clos' };

// Options <select> des 9 types actifs avec libellé complet (édition du détail).
export const CONTRACT_TYPE_OPTIONS = Object.entries(CONTRACT_MODELS).flatMap(
  ([model, modelLabel]) =>
    Object.entries(RIGHTS_SCOPES).map(([scope, scopeLabel]) => ({
      value: `${model}_${scope}`,
      label: `${modelLabel} · ${scopeLabel}`,
    }))
);

// Libellé + couleur d'un type (combiné, legacy ou inconnu) en un seul appel.
export function contractTypeMeta(type) {
  if (!type) return { label: '—', color: '#888' };
  for (const model of Object.keys(CONTRACT_MODELS)) {
    const prefix = `${model}_`;
    if (String(type).startsWith(prefix)) {
      const scope = type.slice(prefix.length);
      return {
        label: `${CONTRACT_MODELS[model]} · ${RIGHTS_SCOPES[scope] || scope}`,
        color: CONTRACT_MODEL_COLORS[model] || '#888',
      };
    }
  }
  return { label: CONTRACT_TYPE_LABELS[type] || type, color: CONTRACT_MODEL_COLORS[type] || '#888' };
}

// ── Choix du wizard de création (cartes modèle / périmètre) ─────────────────
// Libellés et couleurs DÉRIVÉS des maps ci-dessus (jamais redéclarés) ;
// les defaults doivent rester alignés sur server/contract-routes.js.
export const CONTRACT_MODEL_CHOICES = [
  {
    value: 'harmattan_2024',
    desc: 'Contrat standard L\'Harmattan Sénégal',
    defaults: { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
  },
  {
    value: 'harmattan_dll',
    desc: 'DLL : 15 % sur les 1 000 premiers ex., puis 10 % au-delà',
    defaults: { royalty_rate_print: 15, royalty_rate_digital: 10, royalty_threshold: 1000, free_author_copies: 55 },
  },
  {
    value: 'tamarinier',
    desc: 'Collection Le Tamarinier (s/c L\'Harmattan Sénégal)',
    defaults: { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
  },
].map(c => ({ ...c, label: CONTRACT_MODELS[c.value], color: CONTRACT_MODEL_COLORS[c.value] }));

export const RIGHTS_SCOPE_CHOICES = [
  {
    value: 'edition_simple',
    label: 'Édition · papier seul',
    desc: 'Sans avenant numérique, audiovisuel ni théâtral',
    color: '#475569',
    defaults: { royalty_rate_digital: 0 },
  },
  {
    value: 'edition_numerique',
    label: 'Édition · papier + numérique',
    desc: 'Contrat principal + avenant droits numériques',
    color: '#0d9488',
    defaults: { royalty_rate_digital: 10 },
  },
  {
    value: 'edition_complete',
    label: 'Édition · complète',
    desc: 'Papier + numérique + adaptations audiovisuelle & théâtrale',
    color: '#7c3aed',
    defaults: { royalty_rate_digital: 10 },
  },
];
