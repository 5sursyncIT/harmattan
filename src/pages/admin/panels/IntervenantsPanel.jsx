import { useState, useEffect, useMemo } from 'react';
import {
  FiUserPlus, FiTrash2, FiEdit2, FiSave, FiX, FiPower, FiSearch, FiMail,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import { intervenantsApi, INTERVENANT_METIERS } from '../../../api/manuscripts';

const METIER_LABEL = Object.fromEntries(INTERVENANT_METIERS.map((m) => [m.value, m.label]));
const METIER_COLOR = {
  evaluateur: '#9333ea', correcteur: '#14b8a6', infographiste: '#c026d3', imprimeur: '#854d0e',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_FORM = { nom: '', email: '', metier: 'correcteur', notes: '' };

export default function IntervenantsPanel() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterMetier, setFilterMetier] = useState('');
  const [filterActive, setFilterActive] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);

  const load = () => {
    setLoading(true);
    intervenantsApi.list()
      .then((r) => setList(r.data))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((i) => {
      if (q && !i.nom.toLowerCase().includes(q) && !(i.email || '').toLowerCase().includes(q)) return false;
      if (filterMetier && i.metier !== filterMetier) return false;
      if (filterActive === '1' && !i.is_active) return false;
      if (filterActive === '0' && i.is_active) return false;
      return true;
    });
  }, [list, search, filterMetier, filterActive]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.nom.trim()) return toast.error('Nom requis');
    if (!EMAIL_RE.test(form.email.trim())) return toast.error('Email invalide');
    setSaving(true);
    try {
      const res = await intervenantsApi.create({
        nom: form.nom.trim(), email: form.email.trim(), metier: form.metier, notes: form.notes.trim(),
      });
      setList([...list, res.data]);
      setForm(EMPTY_FORM);
      setShowForm(false);
      toast.success(`Intervenant « ${res.data.nom} » ajouté`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(i) {
    setEditingId(i.id);
    setEditForm({ nom: i.nom, email: i.email, metier: i.metier, notes: i.notes || '' });
  }
  function cancelEdit() { setEditingId(null); setEditForm(EMPTY_FORM); }

  async function handleUpdate(i) {
    if (!editForm.nom.trim()) return toast.error('Nom requis');
    if (!EMAIL_RE.test(editForm.email.trim())) return toast.error('Email invalide');
    try {
      const res = await intervenantsApi.update(i.id, {
        nom: editForm.nom.trim(), email: editForm.email.trim(), metier: editForm.metier, notes: editForm.notes.trim(),
      });
      setList(list.map((x) => (x.id === i.id ? res.data : x)));
      toast.success('Intervenant mis à jour');
      cancelEdit();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  async function toggleActive(i) {
    try {
      const res = await intervenantsApi.setActive(i.id, !i.is_active);
      setList(list.map((x) => (x.id === i.id ? res.data : x)));
      toast.success(i.is_active ? 'Intervenant désactivé' : 'Intervenant activé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  async function handleDelete(i) {
    if (!confirm(`Supprimer l'intervenant « ${i.nom} » ?`)) return;
    try {
      const res = await intervenantsApi.remove(i.id);
      if (res.data?.softDeleted) {
        // Référencé par un manuscrit → désactivé plutôt que supprimé.
        setList(list.map((x) => (x.id === i.id ? { ...x, is_active: 0 } : x)));
        toast('Intervenant désactivé (référencé par un manuscrit)', { icon: 'ℹ️' });
      } else {
        setList(list.filter((x) => x.id !== i.id));
        toast.success('Intervenant supprimé');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  if (loading) return <div className="admin-card">Chargement…</div>;

  return (
    <div className="admin-panel">
      <div className="admin-card" style={{ padding: 12 }}>
        <p style={{ margin: '0 0 10px', color: '#6b7280', fontSize: 13 }}>
          Carnet des intervenants externes du workflow éditorial (évaluateurs/lecteurs, correcteurs,
          infographistes, imprimeurs). Ils n'ont <strong>pas de compte</strong> : ils sont affectés aux
          manuscrits et <strong>notifiés par email</strong> avec un lien de téléchargement sécurisé.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
            <FiSearch style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input
              type="text" placeholder="Rechercher nom ou email…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
          </div>
          <select value={filterMetier} onChange={(e) => setFilterMetier(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}>
            <option value="">Tous les métiers</option>
            {INTERVENANT_METIERS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}>
            <option value="">Tous les statuts</option>
            <option value="1">Actifs</option>
            <option value="0">Désactivés</option>
          </select>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            <FiUserPlus /> Nouvel intervenant
          </button>
        </div>
      </div>

      {showForm && (
        <div className="admin-card">
          <h3 style={{ margin: '0 0 12px' }}>Ajouter un intervenant</h3>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="admin-field" style={{ flex: 1, minWidth: 150 }}>
              <label>Nom</label>
              <input type="text" value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} placeholder="ex: Sada Kane" required />
            </div>
            <div className="admin-field" style={{ flex: 1, minWidth: 200 }}>
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ex: contact@exemple.com" required />
            </div>
            <div className="admin-field" style={{ minWidth: 170 }}>
              <label>Métier</label>
              <select value={form.metier} onChange={(e) => setForm({ ...form, metier: e.target.value })} style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}>
                {INTERVENANT_METIERS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="admin-field" style={{ flex: 1, minWidth: 200 }}>
              <label>Notes <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optionnel)</span></label>
              <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="téléphone, spécialité…" />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Ajout…' : 'Ajouter'}</button>
          </form>
        </div>
      )}

      <div className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Email</th>
                <th>Métier</th>
                <th>Notes</th>
                <th>Statut</th>
                <th style={{ width: 140 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>Aucun intervenant.</td></tr>
              )}
              {filtered.map((i) => {
                const isEditing = editingId === i.id;
                if (isEditing) {
                  return (
                    <tr key={i.id} style={{ background: '#fefce8' }}>
                      <td><input type="text" value={editForm.nom} onChange={(e) => setEditForm({ ...editForm, nom: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} /></td>
                      <td><input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} /></td>
                      <td>
                        <select value={editForm.metier} onChange={(e) => setEditForm({ ...editForm, metier: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}>
                          {INTERVENANT_METIERS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </td>
                      <td><input type="text" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} /></td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>—</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn-icon" onClick={() => handleUpdate(i)} title="Enregistrer" style={{ color: '#10531a' }}><FiSave size={14} /></button>
                          <button className="btn-icon" onClick={cancelEdit} title="Annuler"><FiX size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.55 }}>
                    <td><strong>{i.nom}</strong></td>
                    <td style={{ fontSize: '0.85rem' }}>
                      <a href={`mailto:${i.email}`} style={{ color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiMail size={12} /> {i.email}
                      </a>
                    </td>
                    <td>
                      <span style={{ padding: '2px 8px', borderRadius: 4, background: `${METIER_COLOR[i.metier] || '#6b7280'}15`, color: METIER_COLOR[i.metier] || '#6b7280', fontSize: '0.8rem', fontWeight: 700 }}>
                        {METIER_LABEL[i.metier] || i.metier}
                      </span>
                    </td>
                    <td style={{ color: i.notes ? '#374151' : '#9ca3af', fontSize: '0.82rem' }}>{i.notes || '—'}</td>
                    <td>
                      {i.is_active
                        ? <span style={{ color: '#059669', fontSize: 12, fontWeight: 600 }}>Actif</span>
                        : <span style={{ color: '#dc2626', fontSize: 12, fontWeight: 600 }}>Désactivé</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn-icon" onClick={() => startEdit(i)} title="Modifier"><FiEdit2 size={14} /></button>
                        <button className="btn-icon" onClick={() => toggleActive(i)} title={i.is_active ? 'Désactiver' : 'Activer'} style={{ color: i.is_active ? '#dc2626' : '#059669' }}><FiPower size={14} /></button>
                        <button className="btn-icon danger" onClick={() => handleDelete(i)} title="Supprimer"><FiTrash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
