import { useState, useEffect } from 'react';
import { FiX, FiSave, FiAlertCircle } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { createAdminSociete, updateAdminSociete } from '../../api/admin';
import './TiersFormModal.css';

const TYPES = [
  { value: '1', label: 'Client' },
  { value: '2', label: 'Prospect' },
  { value: '3', label: 'Client + prospect' },
  { value: '0', label: 'Aucun' },
];

function emptyForm() {
  return {
    is_company: false,
    firstname: '',
    name: '',
    name_alias: '',
    email: '',
    phone: '',
    address: '',
    zip: '',
    town: '',
    siret: '',
    tva_intra: '',
    note_private: '',
    client: '1',
    fournisseur: false,
    auto_code: true,
  };
}

export default function TiersFormModal({ tier, onClose, onSaved }) {
  const isEdit = Boolean(tier?.id);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (tier) {
      setForm({
        name: tier.nom || tier.name || '',
        name_alias: tier.name_alias || '',
        email: tier.email || '',
        phone: tier.phone || '',
        address: tier.address || '',
        zip: tier.zip || '',
        town: tier.town || '',
        siret: tier.siret || '',
        tva_intra: tier.tva_intra || '',
        note_private: tier.note_private || '',
        client: String(tier.client ?? 1),
        fournisseur: tier.fournisseur === 1 || tier.fournisseur === '1',
        auto_code: false,
      });
    } else {
      setForm(emptyForm());
    }
    setErrors({});
  }, [tier]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const validate = () => {
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = 'Nom requis (2 caractères min.)';
    // À la création : prénom requis pour un particulier, et au moins un identifiant.
    if (!isEdit) {
      if (!form.is_company && (!form.firstname.trim() || form.firstname.trim().length < 2)) errs.firstname = 'Prénom requis (2 caractères min.)';
      if (!form.phone.trim() && !form.email.trim()) { errs.phone = 'Téléphone ou email requis'; errs.email = 'Téléphone ou email requis'; }
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Email invalide';
    if (form.client === '0' && !form.fournisseur) errs.client = 'Sélectionnez au moins un type (client/prospect ou fournisseur)';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        firstname: form.firstname.trim(),
        is_company: form.is_company,
        name_alias: form.name_alias.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        zip: form.zip.trim() || null,
        town: form.town.trim() || null,
        siret: form.siret.trim() || null,
        tva_intra: form.tva_intra.trim() || null,
        note_private: form.note_private.trim() || null,
        client: parseInt(form.client) || 0,
        fournisseur: form.fournisseur ? 1 : 0,
      };
      if (!isEdit && form.auto_code) {
        if (payload.client) payload.code_client = -1;
        if (payload.fournisseur) payload.code_fournisseur = -1;
      }

      if (isEdit) {
        await updateAdminSociete(tier.id, payload);
        toast.success('Tiers mis à jour');
      } else {
        const res = await createAdminSociete(payload);
        toast.success(`Tiers créé : ${res.data.name}`);
      }
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur enregistrement');
    } finally {
      setSubmitting(false);
    }
  };

  const F = ({ label, name, type = 'text', required, full, children }) => (
    <div className={`tiers-field ${full ? 'tiers-field-full' : ''} ${errors[name] ? 'has-error' : ''}`}>
      <label>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      {children || (
        <input type={type} value={form[name]} onChange={e => set(name, e.target.value)} />
      )}
      {errors[name] && <span className="tiers-field-error"><FiAlertCircle size={12} /> {errors[name]}</span>}
    </div>
  );

  return (
    <div className="tiers-modal-overlay" onClick={onClose}>
      <div className="tiers-modal" onClick={e => e.stopPropagation()}>
        <div className="tiers-modal-header">
          <h3 style={{ margin: 0 }}>{isEdit ? `Modifier le tiers : ${tier.nom}` : 'Nouveau tiers'}</h3>
          <button className="btn-ghost" onClick={onClose}><FiX size={18} /></button>
        </div>

        <div className="tiers-modal-body">
          <h5 className="tiers-section">Identification</h5>
          <div className="tiers-grid">
            {!isEdit && (
              <div className="tiers-field tiers-field-full">
                <label>Nature</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className={`btn ${!form.is_company ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => set('is_company', false)}>Particulier</button>
                  <button type="button" className={`btn ${form.is_company ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => set('is_company', true)}>Entreprise / organisation</button>
                </div>
              </div>
            )}
            {!isEdit && !form.is_company && (
              F({ label: 'Prénom', name: 'firstname', required: true })
            )}
            {F({ label: form.is_company ? 'Raison sociale' : 'Nom', name: 'name', required: true, full: isEdit || form.is_company })}
            {F({ label: 'Nom alternatif', name: 'name_alias' })}
            <div className="tiers-field">
              <label>Type</label>
              <select value={form.client} onChange={e => set('client', e.target.value)}>
                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {errors.client && <span className="tiers-field-error"><FiAlertCircle size={12} /> {errors.client}</span>}
            </div>
            <div className="tiers-field" style={{ alignSelf: 'end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                <input type="checkbox" checked={form.fournisseur} onChange={e => set('fournisseur', e.target.checked)} />
                Aussi fournisseur
              </label>
            </div>
            {!isEdit && (
              <div className="tiers-field tiers-field-full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                  <input type="checkbox" checked={form.auto_code} onChange={e => set('auto_code', e.target.checked)} />
                  Générer automatiquement le code client / fournisseur
                </label>
              </div>
            )}
          </div>

          <h5 className="tiers-section">Contact</h5>
          <div className="tiers-grid">
            {F({ label: 'Email', name: 'email', type: 'email' })}
            {F({ label: 'Téléphone', name: 'phone', type: 'tel' })}
            {F({ label: 'Adresse', name: 'address', full: true })}
            {F({ label: 'Code postal', name: 'zip' })}
            {F({ label: 'Ville', name: 'town' })}
          </div>

          <h5 className="tiers-section">Informations fiscales</h5>
          <div className="tiers-grid">
            {F({ label: 'SIRET / NINEA', name: 'siret' })}
            {F({ label: 'TVA intracom.', name: 'tva_intra' })}
          </div>

          <h5 className="tiers-section">Note interne</h5>
          <div className="tiers-grid">
            <div className="tiers-field tiers-field-full">
              <textarea rows={3} value={form.note_private} onChange={e => set('note_private', e.target.value)}
                placeholder="Visible uniquement en interne" />
            </div>
          </div>
        </div>

        <div className="tiers-modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Enregistrement…' : (<><FiSave size={14} /> {isEdit ? 'Enregistrer' : 'Créer'}</>)}
          </button>
        </div>
      </div>
    </div>
  );
}
