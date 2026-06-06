import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getFullSiteConfig, updateSiteConfig } from '../../../api/admin';
import { FiTrash2, FiPlus } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function ConfigPanel() {
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getFullSiteConfig().then((res) => setConfig(res.data)).catch(() => toast.error('Erreur chargement config'));
  }, []);

  const save = async (section, data) => {
    setSaving(true);
    try {
      await updateSiteConfig({ [section]: data });
      setConfig((c) => ({ ...c, [section]: data }));
      toast.success('Sauvegardé');
    } catch {
      toast.error('Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <p>Chargement...</p>;

  return (
    <div className="admin-panel">
      {/* Contact Info */}
      <section className="admin-section">
        <h2>Coordonnées</h2>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label>Adresse complète</label>
            <input value={config.contact?.address || ''} onChange={(e) => setConfig({ ...config, contact: { ...config.contact, address: e.target.value } })} />
          </div>
          <div className="admin-field">
            <label>Adresse courte (footer)</label>
            <input value={config.contact?.address_short || ''} onChange={(e) => setConfig({ ...config, contact: { ...config.contact, address_short: e.target.value } })} />
          </div>
          <div className="admin-field">
            <label>Téléphones (un par ligne)</label>
            <textarea rows={3} value={(config.contact?.phones || []).join('\n')} onChange={(e) => setConfig({ ...config, contact: { ...config.contact, phones: e.target.value.split('\n').filter(Boolean) } })} />
          </div>
          <div className="admin-field">
            <label>Emails (un par ligne)</label>
            <textarea rows={2} value={(config.contact?.emails || []).join('\n')} onChange={(e) => setConfig({ ...config, contact: { ...config.contact, emails: e.target.value.split('\n').filter(Boolean) } })} />
          </div>
          <div className="admin-field">
            <label>Horaires (header/footer)</label>
            <input value={config.contact?.hours || ''} onChange={(e) => setConfig({ ...config, contact: { ...config.contact, hours: e.target.value } })} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => save('contact', config.contact)} disabled={saving}>Sauvegarder les coordonnées</button>
      </section>

      {/* Departments */}
      <section className="admin-section">
        <h2>Départements & routage emails</h2>
        <p className="admin-hint">Les messages du formulaire de contact sont envoyés à l'email du département choisi par le visiteur.</p>
        <div className="admin-dept-list">
          {(config.contact?.departments || []).map((dept, i) => (
            <div key={i} className="admin-dept-row">
              <div className="admin-field">
                <label>Nom</label>
                <input value={dept.label} onChange={(e) => {
                  const depts = [...(config.contact?.departments || [])];
                  depts[i] = { ...depts[i], label: e.target.value, value: e.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_') };
                  setConfig({ ...config, contact: { ...config.contact, departments: depts } });
                }} />
              </div>
              <div className="admin-field" style={{ flex: 2 }}>
                <label>Email de destination</label>
                <input type="email" value={dept.email || ''} onChange={(e) => {
                  const depts = [...(config.contact?.departments || [])];
                  depts[i] = { ...depts[i], email: e.target.value };
                  setConfig({ ...config, contact: { ...config.contact, departments: depts } });
                }} />
              </div>
              <button className="btn-icon danger" style={{ alignSelf: 'flex-end', marginBottom: '4px' }} onClick={() => {
                const depts = (config.contact?.departments || []).filter((_, j) => j !== i);
                setConfig({ ...config, contact: { ...config.contact, departments: depts } });
              }}><FiTrash2 /></button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-outline" onClick={() => {
            const depts = [...(config.contact?.departments || []), { value: '', label: '', email: '' }];
            setConfig({ ...config, contact: { ...config.contact, departments: depts } });
          }}><FiPlus /> Ajouter un département</button>
          <button className="btn btn-primary" onClick={() => save('contact', config.contact)} disabled={saving}>Sauvegarder</button>
        </div>
      </section>

      {/* Social */}
      <section className="admin-section">
        <h2>Réseaux sociaux</h2>
        <div className="admin-form-grid">
          {['facebook', 'youtube', 'twitter', 'linkedin'].map((s) => (
            <div className="admin-field" key={s}>
              <label>{s.charAt(0).toUpperCase() + s.slice(1)}</label>
              <input value={config.social?.[s] || ''} onChange={(e) => setConfig({ ...config, social: { ...config.social, [s]: e.target.value } })} />
            </div>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => save('social', config.social)} disabled={saving}>Sauvegarder les réseaux sociaux</button>
      </section>

      {/* YouTube */}
      <section className="admin-section">
        <h2>Chaîne YouTube</h2>
        <div className="admin-field">
          <label>Channel ID</label>
          <input value={config.youtube_channel_id || ''} onChange={(e) => setConfig({ ...config, youtube_channel_id: e.target.value })} />
          <small>Trouvable dans l'URL de la chaîne ou via YouTube Studio</small>
        </div>
        <button className="btn btn-primary" onClick={() => save('youtube_channel_id', config.youtube_channel_id)} disabled={saving}>Sauvegarder</button>
      </section>

      <section className="admin-section">
        <h2>Ouvrages à paraître</h2>
        <p className="admin-hint">
          Cette section est désormais pilotée depuis le catalogue. Pour qu'un livre apparaisse
          dans « Ouvrages à paraître » sur la page d'accueil, ouvrez sa fiche dans{' '}
          <Link to="/admin/books">Catalogue&nbsp;›&nbsp;Livres</Link> et cochez
          « Ouvrage à paraître ». La date de parution, l'accroche et la remise de précommande
          se règlent au même endroit. Le titre, l'auteur et la couverture sont repris automatiquement
          du livre — plus aucune double saisie.
        </p>
      </section>

      {/* SMTP */}
      <section className="admin-section">
        <h2>Configuration email (SMTP)</h2>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label>Serveur SMTP</label>
            <input value={config.smtp?.host || ''} onChange={(e) => setConfig({ ...config, smtp: { ...config.smtp, host: e.target.value } })} />
          </div>
          <div className="admin-field">
            <label>Port</label>
            <input type="number" value={config.smtp?.port || 587} onChange={(e) => setConfig({ ...config, smtp: { ...config.smtp, port: parseInt(e.target.value) } })} />
          </div>
          <div className="admin-field">
            <label>Utilisateur</label>
            <input value={config.smtp?.user || ''} onChange={(e) => setConfig({ ...config, smtp: { ...config.smtp, user: e.target.value } })} />
          </div>
          <div className="admin-field">
            <label>Mot de passe</label>
            <input type="password" value={config.smtp?.pass || ''} onChange={(e) => setConfig({ ...config, smtp: { ...config.smtp, pass: e.target.value } })} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => save('smtp', config.smtp)} disabled={saving}>Sauvegarder SMTP</button>
      </section>
    </div>
  );
}
