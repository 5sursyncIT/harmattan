import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FiDownload, FiUpload, FiCheckCircle, FiAlertTriangle, FiLock, FiFileText } from 'react-icons/fi';
import { depositApi } from '../api/manuscripts';

/**
 * Page publique de dépôt d'une version révisée du manuscrit (lien tokenisé,
 * sans connexion). L'auteur y télécharge la version courante et dépose sa
 * version révisée — elle devient la version courante côté maison d'édition.
 */
export default function ManuscriptDepositPage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { version }
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    depositApi.info(token)
      .then((res) => setInfo(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Lien de dépôt invalide.'))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { setUploadError('Choisissez le fichier de votre version révisée.'); return; }
    setBusy(true);
    setUploadError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (note.trim()) fd.append('note', note.trim());
      const res = await depositApi.upload(token, fd);
      setDone({ version: res.data?.version });
    } catch (err) {
      setUploadError(err.response?.data?.error || 'Erreur lors du dépôt. Réessayez.');
    } finally {
      setBusy(false);
    }
  };

  const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', marginBottom: 16 };

  return (
    <div className="container" style={{ maxWidth: 680, margin: '0 auto', padding: '32px 16px 64px' }}>
      <h1 style={{ color: '#10531a', fontSize: '1.5rem', marginBottom: 6 }}>Dépôt de votre version révisée</h1>
      <p style={{ color: '#6b7280', marginTop: 0 }}>L&apos;Harmattan Sénégal — espace de dépôt sécurisé</p>

      {loading && <p>Chargement…</p>}

      {!loading && error && (
        <div style={{ ...card, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b' }}>
          <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 8 }} />{error}
        </div>
      )}

      {!loading && !error && info && (
        <>
          <div style={card}>
            <h2 style={{ fontSize: '1.05rem', margin: '0 0 10px' }}>
              <FiFileText style={{ verticalAlign: 'middle', marginRight: 6 }} />
              « {info.manuscript.title} »
              {info.manuscript.subtitle ? <span style={{ fontStyle: 'italic', color: '#6b7280' }}> — {info.manuscript.subtitle}</span> : null}
            </h2>
            <p style={{ margin: '0 0 4px', fontSize: '0.9rem', color: '#4b5563' }}>
              Référence <strong>{info.manuscript.ref}</strong> · {info.manuscript.author_name}
            </p>
            {info.message && (
              <p style={{ background: '#f3f6f3', borderLeft: '4px solid #10531a', padding: '10px 14px', borderRadius: 4, whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
                {info.message}
              </p>
            )}
            {info.current ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <div style={{ fontSize: '0.88rem' }}>
                  Version actuelle : <strong>v{info.current.version} — {info.current.file_name}</strong>
                  <div style={{ color: '#6b7280', fontSize: '0.8rem' }}>
                    déposée le {new Date(info.current.uploaded_at).toLocaleDateString('fr-FR')}
                  </div>
                </div>
                <a
                  href={depositApi.downloadUrl(token)}
                  style={{ background: '#fff', border: '1px solid #10531a', color: '#10531a', padding: '8px 14px', borderRadius: 8, textDecoration: 'none', fontSize: '0.88rem', whiteSpace: 'nowrap' }}
                >
                  <FiDownload style={{ verticalAlign: 'middle', marginRight: 6 }} />Télécharger la version actuelle
                </a>
              </div>
            ) : (
              <p style={{ color: '#6b7280', fontSize: '0.88rem' }}>Aucune version téléchargeable pour le moment.</p>
            )}
          </div>

          {info.locked ? (
            <div style={{ ...card, borderColor: '#d1d5db', background: '#f9fafb', color: '#4b5563' }}>
              <FiLock style={{ verticalAlign: 'middle', marginRight: 8 }} />
              La version définitive de ce manuscrit a été arrêtée : plus aucun dépôt n&apos;est possible.
              Contactez la maison d&apos;édition si besoin.
            </div>
          ) : done ? (
            <div style={{ ...card, borderColor: '#bbf7d0', background: '#f0fdf4', color: '#14532d' }}>
              <FiCheckCircle style={{ verticalAlign: 'middle', marginRight: 8 }} />
              <strong>Version v{done.version} bien reçue.</strong> Elle est désormais la version courante
              de votre manuscrit ; l&apos;équipe éditoriale a été prévenue. Vous pouvez fermer cette page.
            </div>
          ) : (
            <form onSubmit={submit} style={card}>
              <h2 style={{ fontSize: '1.05rem', margin: '0 0 10px' }}>
                <FiUpload style={{ verticalAlign: 'middle', marginRight: 6 }} />Déposer votre version révisée
              </h2>
              <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 0 }}>
                Formats acceptés : PDF, DOC, DOCX, ODT, RTF — max {info.max_mb} Mo.
                Dépôts restants sur ce lien : {info.remaining_uploads}
                {' '}· lien valable jusqu&apos;au {new Date(info.expires_at).toLocaleDateString('fr-FR')}.
              </p>
              <div style={{ marginBottom: 12 }}>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.odt,.rtf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: '#4b5563', marginBottom: 4 }}>
                  Message pour l&apos;équipe éditoriale (facultatif)
                </label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Ex. : corrections des chapitres 3 et 5 intégrées."
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>
              {uploadError && (
                <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>
                  <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 6 }} />{uploadError}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                style={{ background: '#10531a', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}
              >
                {busy ? 'Envoi en cours…' : 'Déposer ma version révisée'}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
