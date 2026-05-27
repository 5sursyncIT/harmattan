import { useEffect } from 'react';
import { FiX, FiDownload, FiExternalLink } from 'react-icons/fi';

export default function PdfViewerModal({ url, title, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!url) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1100,
          height: '92vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid #e5e7eb',
        }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{title || 'Document PDF'}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <a
              className="btn btn-outline"
              href={url}
              download
              style={{ fontSize: 13, padding: '6px 12px' }}
              title="Télécharger le PDF"
            >
              <FiDownload /> Télécharger
            </a>
            <a
              className="btn btn-outline"
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, padding: '6px 12px' }}
              title="Ouvrir dans un nouvel onglet"
            >
              <FiExternalLink /> Plein écran
            </a>
            <button
              className="btn-ghost"
              onClick={onClose}
              aria-label="Fermer"
              style={{ fontSize: 18 }}
            >
              <FiX />
            </button>
          </div>
        </div>
        <iframe
          src={url}
          title={title || 'PDF'}
          style={{ flex: 1, width: '100%', border: 'none', background: '#525659' }}
        />
      </div>
    </div>
  );
}
