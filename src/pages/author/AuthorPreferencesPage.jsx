import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiBell, FiSave, FiInfo } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import './AuthorPages.css';
import './AuthorPreferencesPage.css';

const CATEGORIES = [
  {
    key: 'workflow',
    label: 'Étapes du workflow éditorial',
    description: 'Évaluation du manuscrit, corrections, validations éditoriales, mises à jour générales.',
  },
  {
    key: 'cover',
    label: 'Conception de couverture',
    description: 'Lancement de la conception et soumission du BAT (bon à tirer) couverture pour validation.',
  },
  {
    key: 'print',
    label: 'Impression et livraison',
    description: 'Préparation de l\'impression, lancement, fin de fabrication.',
  },
  {
    key: 'reminders',
    label: 'Rappels en cas d\'inaction',
    description: 'Si une validation de votre part est en attente depuis plus de 7 ou 14 jours.',
  },
];

export default function AuthorPreferencesPage() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    authorApi.getPreferences()
      .then((res) => setPrefs(res.data))
      .catch((err) => {
        if (err.response?.status === 401) navigate('/auteur/connexion');
        else toast.error('Erreur de chargement');
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  const toggle = (key) => {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
    setDirty(true);
  };

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      const res = await authorApi.updatePreferences({
        workflow: prefs.workflow,
        cover: prefs.cover,
        print: prefs.print,
        reminders: prefs.reminders,
      });
      setPrefs(res.data);
      setDirty(false);
      toast.success('Préférences enregistrées');
    } catch {
      toast.error('Erreur d\'enregistrement');
    } finally { setSaving(false); }
  };

  if (loading || !prefs) {
    return (
      <div className="author-page">
        <div className="container"><p>Chargement…</p></div>
      </div>
    );
  }

  return (
    <div className="author-page">
      <div className="container">
        <Link to="/auteur/dashboard" className="back-link"><FiArrowLeft /> Retour au tableau de bord</Link>

        <div className="author-detail-header">
          <div>
            <h1><FiBell style={{ verticalAlign: '-3px', marginRight: 8 }} /> Mes préférences de notification</h1>
            <p className="author-subtitle">
              Choisissez les emails que vous souhaitez recevoir. Les notifications dans votre espace restent toujours visibles.
            </p>
          </div>
          <div className="author-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={!dirty || saving}
            >
              <FiSave /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>

        <div className="prefs-info">
          <FiInfo />
          <p>
            <strong>Les emails liés au contrat, à la signature et au paiement</strong> restent toujours actifs — ils sont essentiels au suivi de votre projet et ne peuvent pas être désactivés.
          </p>
        </div>

        <div className="prefs-list">
          {CATEGORIES.map((cat) => (
            <div key={cat.key} className="prefs-item">
              <div className="prefs-item-text">
                <strong>{cat.label}</strong>
                <span>{cat.description}</span>
              </div>
              <label className="prefs-switch">
                <input
                  type="checkbox"
                  checked={!!prefs[cat.key]}
                  onChange={() => toggle(cat.key)}
                  aria-label={`Activer les emails pour ${cat.label}`}
                />
                <span className="prefs-switch-slider" />
              </label>
            </div>
          ))}

          <div className="prefs-item prefs-item-locked">
            <div className="prefs-item-text">
              <strong>Contrat, signature, paiement</strong>
              <span>Étapes critiques — toujours actives.</span>
            </div>
            <span className="prefs-locked-badge">Toujours actif</span>
          </div>
        </div>
      </div>
    </div>
  );
}
