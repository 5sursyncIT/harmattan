import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload, FiArrowLeft, FiFile, FiX, FiSend, FiInfo } from 'react-icons/fi';
import { authorApi } from '../../api/author';
import './AuthorPages.css';

const MAX_BIOGRAPHY = 800;

const GENRES = [
  'Roman', 'Nouvelle', 'Poésie', 'Théâtre', 'Essai', 'Biographie',
  'Histoire', 'Sciences sociales', 'Sciences', 'Jeunesse', 'Autre',
];

const MAX_FILE_MB = 20;
const MAX_SYNOPSIS = 2000;
const MAX_MESSAGE = 1000;
const ACCEPTED_EXT = ['.pdf', '.doc', '.docx', '.odt', '.rtf'];

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export default function AuthorSubmitPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [synopsis, setSynopsis] = useState('');
  const [biography, setBiography] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);

  // Pré-remplir la biographie depuis le profil auteur si elle a déjà été renseignée
  useEffect(() => {
    authorApi.me()
      .then((res) => {
        if (res.data?.bio) setBiography(res.data.bio);
      })
      .catch(() => { /* silent */ });
  }, []);

  const validateFile = (f) => {
    if (!f) return null;
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!ACCEPTED_EXT.includes(ext)) {
      toast.error(`Format non supporté. Acceptés : ${ACCEPTED_EXT.join(', ')}`);
      return null;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      toast.error(`Fichier trop volumineux (max ${MAX_FILE_MB} Mo)`);
      return null;
    }
    return f;
  };

  const handleFileChange = (e) => {
    const f = validateFile(e.target.files?.[0]);
    if (f) setFile(f);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const f = validateFile(e.dataTransfer.files?.[0]);
    if (f) setFile(f);
  };

  const clearFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { toast.error('Le titre est obligatoire'); return; }
    if (!file) { toast.error('Le manuscrit est obligatoire'); return; }
    const fd = new FormData();
    fd.append('title', title.trim());
    if (genre) fd.append('genre', genre);
    if (synopsis) fd.append('synopsis', synopsis);
    if (biography) fd.append('biography', biography);
    if (message) fd.append('message', message);
    fd.append('original', file);
    setLoading(true);
    try {
      const res = await authorApi.submitManuscript(fd);
      toast.success(`Manuscrit soumis : ${res.data.ref}`);
      navigate(`/auteur/manuscrits/${res.data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de soumission');
    } finally { setLoading(false); }
  };

  const isValid = title.trim() && file && !loading;

  return (
    <div className="author-page">
      <div className="container">
        <Link to="/auteur/dashboard" className="back-link"><FiArrowLeft /> Retour à mes manuscrits</Link>

        <div className="author-card submit-card">
          <div className="submit-header">
            <h1>Soumettre un manuscrit</h1>
            <p className="author-subtitle">
              <FiInfo /> Déposez votre manuscrit pour évaluation par notre comité éditorial.
              Réponse sous 6 à 8 semaines.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="submit-form">

            <fieldset className="submit-fieldset">
              <legend>L'œuvre</legend>

              <div className="form-group">
                <label htmlFor="title">Titre <span className="req">*</span></label>
                <input
                  id="title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Le titre exact de votre œuvre"
                  maxLength={255}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="genre">Genre</label>
                <select
                  id="genre"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                >
                  <option value="">— Sélectionner un genre —</option>
                  {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
            </fieldset>

            <fieldset className="submit-fieldset">
              <legend>Présentation</legend>

              <div className="form-group">
                <label htmlFor="synopsis">
                  Synopsis
                  <span className="form-counter">{synopsis.length} / {MAX_SYNOPSIS}</span>
                </label>
                <textarea
                  id="synopsis"
                  value={synopsis}
                  onChange={(e) => setSynopsis(e.target.value.slice(0, MAX_SYNOPSIS))}
                  rows={6}
                  placeholder="Résumé de votre œuvre, thèmes abordés, public visé…"
                />
                <p className="form-hint">Un bon synopsis présente l'intrigue, les personnages principaux et le ton du livre.</p>
              </div>

              <div className="form-group">
                <label htmlFor="biography">
                  Biographie de l'auteur
                  <span className="form-counter">{biography.length} / {MAX_BIOGRAPHY}</span>
                </label>
                <textarea
                  id="biography"
                  value={biography}
                  onChange={(e) => setBiography(e.target.value.slice(0, MAX_BIOGRAPHY))}
                  rows={4}
                  placeholder="Présentez-vous en quelques lignes : parcours, formation, expériences marquantes, précédentes publications…"
                />
                <p className="form-hint">3 à 5 lignes. Cette biographie figurera sur la 4ᵉ de couverture après publication. Réutilisée pour vos prochains manuscrits.</p>
              </div>

              <div className="form-group">
                <label htmlFor="message">
                  Message au comité éditorial
                  <span className="form-counter">{message.length} / {MAX_MESSAGE}</span>
                </label>
                <textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
                  rows={4}
                  placeholder="Contexte de la soumission, attentes vis-à-vis de l'éditeur, informations complémentaires…"
                />
              </div>
            </fieldset>

            <fieldset className="submit-fieldset">
              <legend>Manuscrit <span className="req">*</span></legend>

              {!file ? (
                <label
                  className={`file-dropzone${dragActive ? ' active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <FiUpload size={28} />
                  <div className="file-dropzone-text">
                    <strong>Déposez votre fichier ici</strong>
                    <span>ou cliquez pour parcourir</span>
                  </div>
                  <p className="file-dropzone-hint">
                    PDF, DOC, DOCX, ODT ou RTF — {MAX_FILE_MB} Mo maximum
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_EXT.join(',')}
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                  />
                </label>
              ) : (
                <div className="file-preview">
                  <div className="file-preview-icon"><FiFile size={24} /></div>
                  <div className="file-preview-info">
                    <strong>{file.name}</strong>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                  <button type="button" className="file-preview-remove" onClick={clearFile} aria-label="Retirer le fichier">
                    <FiX size={18} />
                  </button>
                </div>
              )}
            </fieldset>

            <div className="submit-actions">
              <Link to="/auteur/dashboard" className="btn btn-outline">Annuler</Link>
              <button type="submit" className="btn btn-primary btn-lg" disabled={!isValid}>
                <FiSend /> {loading ? 'Envoi en cours…' : 'Soumettre mon manuscrit'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
