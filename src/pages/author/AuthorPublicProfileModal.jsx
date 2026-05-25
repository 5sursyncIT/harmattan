import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiX, FiSave, FiGlobe, FiTwitter, FiInstagram, FiLinkedin, FiFacebook, FiImage } from 'react-icons/fi';
import { authorApi } from '../../api/author';

export default function AuthorPublicProfileModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    bio: '',
    photo_url: '',
    website: '',
    social_twitter: '',
    social_instagram: '',
    social_linkedin: '',
    social_facebook: '',
    public_listed: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    authorApi.me()
      .then((res) => {
        const a = res.data;
        setForm({
          bio: a.bio || '',
          photo_url: a.photo_url || '',
          website: a.website || '',
          social_twitter: a.socials?.twitter || '',
          social_instagram: a.socials?.instagram || '',
          social_linkedin: a.socials?.linkedin || '',
          social_facebook: a.socials?.facebook || '',
          public_listed: !!a.public_listed,
        });
      })
      .catch(() => toast.error('Erreur chargement profil'))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: val }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await authorApi.updateProfilePublic(form);
      toast.success(form.public_listed ? 'Profil public mis à jour' : 'Profil enregistré (non publié)');
      onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="author-modal-backdrop" onClick={onClose}>
      <div className="author-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0 }}>Mon profil public</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              Ces informations apparaîtront sur votre page profil dans l'annuaire des auteurs.
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>

        {loading ? (
          <p>Chargement…</p>
        ) : (
          <form onSubmit={handleSave} className="submit-form">
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={form.public_listed}
                  onChange={handleChange('public_listed')}
                  style={{ marginRight: 8 }}
                />
                Apparaître dans l'annuaire public des auteurs
              </label>
              <p className="form-hint">
                Si décoché, votre profil ne sera pas visible sur le site (uniquement votre nom restera sur vos livres).
              </p>
            </div>

            <div className="form-group">
              <label>Biographie</label>
              <textarea
                value={form.bio}
                onChange={handleChange('bio')}
                rows={6}
                placeholder="Présentez-vous en quelques lignes. Vous pouvez utiliser des paragraphes pour structurer votre texte."
                maxLength={5000}
              />
              <p className="form-hint">Visible sur votre page profil public. {form.bio.length}/5000 caractères.</p>
            </div>

            <div className="form-group">
              <label><FiImage style={{ verticalAlign: 'middle', marginRight: 6 }} /> URL de votre photo</label>
              <input
                type="url"
                value={form.photo_url}
                onChange={handleChange('photo_url')}
                placeholder="https://…/photo.jpg"
              />
              <p className="form-hint">Image carrée idéalement, hébergée ailleurs (l'upload direct viendra plus tard).</p>
            </div>

            <div className="form-group">
              <label><FiGlobe style={{ verticalAlign: 'middle', marginRight: 6 }} /> Site web personnel</label>
              <input type="url" value={form.website} onChange={handleChange('website')} placeholder="https://…" />
            </div>

            <fieldset className="submit-fieldset">
              <legend>Réseaux sociaux</legend>
              <div className="form-group">
                <label><FiTwitter style={{ verticalAlign: 'middle', marginRight: 6 }} /> Twitter / X</label>
                <input type="url" value={form.social_twitter} onChange={handleChange('social_twitter')} placeholder="https://twitter.com/votre_compte" />
              </div>
              <div className="form-group">
                <label><FiInstagram style={{ verticalAlign: 'middle', marginRight: 6 }} /> Instagram</label>
                <input type="url" value={form.social_instagram} onChange={handleChange('social_instagram')} placeholder="https://instagram.com/votre_compte" />
              </div>
              <div className="form-group">
                <label><FiLinkedin style={{ verticalAlign: 'middle', marginRight: 6 }} /> LinkedIn</label>
                <input type="url" value={form.social_linkedin} onChange={handleChange('social_linkedin')} placeholder="https://linkedin.com/in/votre_compte" />
              </div>
              <div className="form-group">
                <label><FiFacebook style={{ verticalAlign: 'middle', marginRight: 6 }} /> Facebook</label>
                <input type="url" value={form.social_facebook} onChange={handleChange('social_facebook')} placeholder="https://facebook.com/votre_page" />
              </div>
            </fieldset>

            <div className="author-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                <FiSave /> {saving ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
