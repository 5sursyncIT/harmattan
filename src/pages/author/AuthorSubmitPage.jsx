import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload } from 'react-icons/fi';
import { authorApi } from '../../api/author';
import './AuthorPages.css';

const GENRES = [
  'Roman', 'Nouvelle', 'Poésie', 'Théâtre', 'Essai', 'Biographie',
  'Histoire', 'Sciences sociales', 'Sciences', 'Jeunesse', 'Autre',
];

export default function AuthorSubmitPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [synopsis, setSynopsis] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title || !file) {
      toast.error('Titre et fichier requis');
      return;
    }
    const fd = new FormData();
    fd.append('title', title);
    if (genre) fd.append('genre', genre);
    if (synopsis) fd.append('synopsis', synopsis);
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

  return (
    <div className="author-page">
      <div className="container">
        <div className="author-card">
          <h1>Soumettre un manuscrit</h1>
          <p className="author-subtitle">Déposez votre manuscrit pour évaluation par notre comité éditorial.</p>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Titre de l'œuvre *</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Genre</label>
                <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                  <option value="">— Sélectionner —</option>
                  {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Synopsis (résumé de l'œuvre)</label>
              <textarea value={synopsis} onChange={(e) => setSynopsis(e.target.value)} rows={5} />
            </div>
            <div className="form-group">
              <label>Message au comité éditorial</label>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
            </div>
            <div className="form-group">
              <label>Manuscrit (PDF, DOC, DOCX, ODT ou RTF — max 20 Mo) *</label>
              <label className="file-upload">
                <FiUpload />
                <span>{file ? file.name : 'Choisir un fichier'}</span>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.odt,.rtf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  required
                  style={{ display: 'none' }}
                />
              </label>
            </div>
            <button type="submit" className="btn btn-primary btn-lg" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Envoi en cours...' : 'Soumettre mon manuscrit'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
