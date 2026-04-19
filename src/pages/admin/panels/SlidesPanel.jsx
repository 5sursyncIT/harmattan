import { useState, useEffect } from 'react';
import { getFullSiteConfig, updateSiteConfig, uploadSliderImage } from '../../../api/admin';
import { FiTrash2, FiPlus, FiUpload, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function SlidesPanel() {
  const [slides, setSlides] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getFullSiteConfig().then((res) => setSlides(res.data.hero_slides || [])).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updateSiteConfig({ hero_slides: slides });
      toast.success('Bannières sauvegardées');
    } catch {
      toast.error('Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (index, file) => {
    try {
      const res = await uploadSliderImage(file);
      const updated = [...slides];
      updated[index] = { ...updated[index], image: res.data.path };
      setSlides(updated);
      toast.success('Image uploadée');
    } catch {
      toast.error("Erreur upload image");
    }
  };

  const addSlide = () => {
    setSlides([...slides, { id: Date.now(), image: '', title: '', subtitle: '', link: '/catalogue', isBanner: false, btnPrimary: '' }]);
  };

  const removeSlide = (index) => {
    setSlides(slides.filter((_, i) => i !== index));
  };

  const updateSlide = (index, field, value) => {
    const updated = [...slides];
    updated[index] = { ...updated[index], [field]: value };
    setSlides(updated);
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <button className="btn btn-outline" onClick={addSlide}><FiPlus /> Ajouter une bannière</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Sauvegarde...' : 'Sauvegarder'}</button>
      </div>

      {slides.map((slide, i) => (
        <div key={slide.id || i} className="admin-card">
          <div className="admin-card-header">
            <h3>Bannière {i + 1}</h3>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn-icon" disabled={i === 0} onClick={() => { const s = [...slides]; [s[i-1], s[i]] = [s[i], s[i-1]]; setSlides(s); }} title="Monter"><FiArrowUp size={14} /></button>
              <button className="btn-icon" disabled={i === slides.length - 1} onClick={() => { const s = [...slides]; [s[i], s[i+1]] = [s[i+1], s[i]]; setSlides(s); }} title="Descendre"><FiArrowDown size={14} /></button>
              <button className="btn-icon danger" onClick={() => { if (confirm('Supprimer cette bannière ?')) removeSlide(i); }}><FiTrash2 /></button>
            </div>
          </div>

          {slide.image && <img src={slide.image} alt="" className="admin-slide-preview" />}

          <div className="admin-form-grid">
            <div className="admin-field">
              <label>Image</label>
              <div className="admin-file-upload">
                <input type="file" accept="image/*" onChange={(e) => e.target.files[0] && handleImageUpload(i, e.target.files[0])} />
                <span><FiUpload /> {slide.image ? 'Changer l\'image' : 'Uploader une image'}</span>
              </div>
            </div>
            <div className="admin-field">
              <label>Titre</label>
              <input value={slide.title || ''} onChange={(e) => updateSlide(i, 'title', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Sous-titre</label>
              <input value={slide.subtitle || ''} onChange={(e) => updateSlide(i, 'subtitle', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Lien</label>
              <input value={slide.link || ''} onChange={(e) => updateSlide(i, 'link', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Texte bouton (vide = pas de bouton)</label>
              <input value={slide.btnPrimary || ''} onChange={(e) => updateSlide(i, 'btnPrimary', e.target.value)} />
            </div>
            <div className="admin-field admin-checkbox">
              <label>
                <input type="checkbox" checked={slide.isBanner || false} onChange={(e) => updateSlide(i, 'isBanner', e.target.checked)} />
                Image plein écran (bannière sans texte overlay)
              </label>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
