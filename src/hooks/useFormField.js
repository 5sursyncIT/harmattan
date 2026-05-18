import { useCallback } from 'react';

/**
 * Hook utilitaire pour factoriser la logique onChange+onBlur d'un champ de formulaire
 * qui interagit avec un state `form`, un setter `setForm`, et un validateur par champ.
 *
 * Usage :
 *   const bind = useFormBinder(setForm, setErrors, runValidation);
 *   <input {...bind('title')} />
 *
 * L'helper retourne { value, onChange, onBlur } avec la valeur courante.
 * runValidation(formKey, currentForm) → { valid, error } optionnel par champ.
 */
export function useFormBinder(form, setForm, setErrors, validateField) {
  return useCallback((key) => ({
    value: form[key] ?? '',
    onChange: (e) => {
      const value = e && e.target ? e.target.value : e;
      setForm((f) => ({ ...f, [key]: value }));
      setErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    onBlur: () => {
      if (validateField) validateField(key);
    },
  }), [form, setForm, setErrors, validateField]);
}
