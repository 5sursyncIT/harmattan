import { useState, useEffect } from 'react';
import { getFullSiteConfig, updateSiteConfig } from '../../../api/admin';
import { FiTrash2, FiPlus } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function FAQPanel() {
  const [faq, setFaq] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getFullSiteConfig().then((res) => setFaq(res.data.faq || [])).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updateSiteConfig({ faq });
      toast.success('FAQ sauvegardée');
    } catch {
      toast.error('Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const addCategory = () => setFaq([...faq, { category: 'Nouvelle catégorie', questions: [] }]);
  const removeCategory = (i) => { if (confirm('Supprimer cette catégorie et toutes ses questions ?')) setFaq(faq.filter((_, idx) => idx !== i)); };
  const updateCategory = (i, value) => {
    const updated = [...faq];
    updated[i] = { ...updated[i], category: value };
    setFaq(updated);
  };

  const addQuestion = (catIdx) => {
    const updated = [...faq];
    updated[catIdx] = { ...updated[catIdx], questions: [...updated[catIdx].questions, { q: '', a: '' }] };
    setFaq(updated);
  };

  const removeQuestion = (catIdx, qIdx) => {
    const updated = [...faq];
    updated[catIdx] = { ...updated[catIdx], questions: updated[catIdx].questions.filter((_, i) => i !== qIdx) };
    setFaq(updated);
  };

  const updateQuestion = (catIdx, qIdx, field, value) => {
    const updated = [...faq];
    const questions = [...updated[catIdx].questions];
    questions[qIdx] = { ...questions[qIdx], [field]: value };
    updated[catIdx] = { ...updated[catIdx], questions };
    setFaq(updated);
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <button className="btn btn-outline" onClick={addCategory}><FiPlus /> Ajouter catégorie</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Sauvegarde...' : 'Sauvegarder'}</button>
      </div>

      {faq.map((cat, ci) => (
        <div key={ci} className="admin-card">
          <div className="admin-card-header">
            <input className="admin-card-title-input" value={cat.category} onChange={(e) => updateCategory(ci, e.target.value)} />
            <button className="btn-icon danger" onClick={() => removeCategory(ci)}><FiTrash2 /></button>
          </div>

          {cat.questions.map((q, qi) => (
            <div key={qi} className="admin-faq-item">
              <div className="admin-field">
                <label>Question</label>
                <input value={q.q} onChange={(e) => updateQuestion(ci, qi, 'q', e.target.value)} />
              </div>
              <div className="admin-field">
                <label>Réponse</label>
                <textarea rows={5} value={q.a} onChange={(e) => updateQuestion(ci, qi, 'a', e.target.value)} style={{ resize: 'vertical', minHeight: 80 }} />
              </div>
              <button className="btn-icon danger small" onClick={() => { if (confirm('Supprimer cette question ?')) removeQuestion(ci, qi); }}><FiTrash2 size={14} /></button>
            </div>
          ))}

          <button className="btn btn-sm btn-outline" onClick={() => addQuestion(ci)}><FiPlus /> Ajouter question</button>
        </div>
      ))}
    </div>
  );
}
