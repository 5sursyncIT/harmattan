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
