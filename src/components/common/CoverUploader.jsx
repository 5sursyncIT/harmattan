import { useEffect, useRef, useState } from 'react';
import { FiCamera, FiImage, FiLoader } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { uploadBookCover } from '../../api/admin';
import { getProduct, getProductImageUrl } from '../../api/dolibarr';

/**
 * Affiche les couvertures d'un livre (recto + verso) + boutons pour changer.
 *
 * Props :
 * - productId  : number (livre existant)
 * - title      : string (alt)
 * - onUpdated  : (productId) => void
 */
export default function CoverUploader({ productId, title, onUpdated }) {
  const [version, setVersion] = useState(0);
  const [versoUrl, setVersoUrl] = useState(null);

  // Charge la liste des images pour détecter si un verso existe déjà
  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    getProduct(productId)
      .then((res) => {
        if (cancelled) return;
        const imgs = res.data?.images || [];
        const verso = imgs.find((i) => i.side === 'verso');
        setVersoUrl(verso ? verso.url : null);
      })
      .catch(() => { if (!cancelled) setVersoUrl(null); });
    return () => { cancelled = true; };
  }, [productId, version]);

  const rectoBase = getProductImageUrl(productId, title);
  const rectoUrl = `${rectoBase}${rectoBase.includes('?') ? '&' : '?'}v=${version}`;
  const handleUploaded = () => {
    setVersion((v) => v + 1);
    if (onUpdated) onUpdated(productId);
  };

  return (
    <div className="book-form-covers-wrap">
      <CoverSide
        side="recto"
        label="Recto"
        productId={productId}
        title={title}
        imageUrl={rectoUrl}
        onUploaded={handleUploaded}
      />
      <CoverSide
        side="verso"
        label="Verso"
        productId={productId}
        title={title}
        imageUrl={versoUrl ? `${versoUrl}&v=${version}` : null}
        onUploaded={handleUploaded}
      />
    </div>
  );
}

function CoverSide({ side, label, productId, title, imageUrl, onUploaded }) {
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setFailed(false); }, [imageUrl]);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(jpg|jpeg|png|webp)$/i.test(file.name)) {
      toast.error('Format accepté : JPG, PNG ou WEBP');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error('Image trop volumineuse (max 8 Mo)');
      return;
    }
    setUploading(true);
    try {
      await uploadBookCover(productId, file, { side });
      toast.success(`${label} mis à jour`);
      setFailed(false);
      onUploaded && onUploaded();
    } catch (err) {
      toast.error(err.response?.data?.error || `Erreur upload ${label.toLowerCase()}`);
    } finally {
      setUploading(false);
    }
  };

  const hasImage = !!imageUrl;

  return (
    <div className="book-form-cover-wrap">
      <div className="book-form-cover">
        {!hasImage || failed ? (
          <div className="cover-fallback cover-fallback-form" aria-label={`Aucun ${label.toLowerCase()}`}>
            <FiImage aria-hidden="true" />
            <span className="cover-fallback-text">{label}</span>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={`${label} — ${title || 'couverture'}`}
            onError={() => setFailed(true)}
          />
        )}
        {uploading && (
          <div className="book-form-cover-overlay">
            <FiLoader className="spin" />
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn-cover-upload"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        title={hasImage ? `Remplacer le ${label.toLowerCase()}` : `Ajouter le ${label.toLowerCase()}`}
        aria-label={hasImage ? `Remplacer le ${label.toLowerCase()}` : `Ajouter le ${label.toLowerCase()}`}
      >
        <FiCamera size={12} aria-hidden="true" /> {uploading ? 'Envoi…' : (hasImage ? `Changer ${label.toLowerCase()}` : `+ ${label}`)}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </div>
  );
}
