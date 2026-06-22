import { useState, useEffect, useMemo } from 'react';
import { FiX, FiPlus, FiTrash2, FiCheckCircle, FiFileText } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { createContractQuote, openQuotePdf } from '../../api/quotes';

const FCFA_PER_EUR = 655.957;
const DEFAULT_AUTHOR_DISCOUNT = 30;  // remise auteur par défaut (%) si non renseignée au contrat
const COLOR_FLAT_PRICE = 852000;     // Prix fixe contribution impression couleur (item 6)

// Choix figés par la direction (menus déroulants). `value` = texte rendu sur le PDF,
// `label` = libellé court affiché à l'éditeur. Le format accepte une saisie libre
// via l'option « Autre » (sentinelle FORMAT_CUSTOM).
const FORMAT_CUSTOM = '__custom__';
const FORMAT_OPTIONS = [
  { label: '135 × 215 mm', value: '13.5 cm sur 21.5 cm' },
  { label: '155 × 240 mm', value: '15.5 cm sur 24 cm' },
  { label: 'A4 (210 × 297 mm)', value: 'A4 (21 cm sur 29.7 cm)' },
];
const INTERIOR_OPTIONS = [
  { label: '1 couleur N&B', value: 'une couleur N & B' },
  { label: 'Mix N&B/Couleur', value: 'mixte N & B / couleur' },
  { label: 'Couleur intégrale', value: 'couleur intégrale' },
];
const PAPER_OPTIONS = [
  { label: 'Bouffant 80 g', value: 'bouffant 80 grammes' },
  { label: 'Offset 90 g', value: 'offset 90 grammes' },
  { label: 'Papier photo 115 g', value: 'papier photo 115 grammes' },
];

function buildDefaultItems({ pages, priceEur, qty, color, discountPct }) {
  const items = [];
  if (pages > 0) {
    items.push({ id: 1, label: '1 - Contribution au frais de relecture et au report de correction', price: pages * 1500 });
    items.push({ id: 2, label: '2 - Contribution à la mise en pages et réalisation du Prêt-à-clicher', price: pages * 1000 });
  }
  if (priceEur > 0 && qty > 0) {
    // L'auteur paie (100 − remise) % du prix public, converti en FCFA.
    // La remise provient du contrat (champ « Remise auteur (%) »), pas d'une valeur figée.
    const remise = Math.min(100, Math.max(0, Number(discountPct) || 0)) / 100;
    items.push({ id: 4, label: `4 - Achat de ${qty} exemplaires contractuels`, price: Math.round(priceEur * qty * FCFA_PER_EUR * (1 - remise)) });
  }
  if (color) {
    items.push({ id: 6, label: '6 - Contribution à l\'impression Couleur', price: COLOR_FLAT_PRICE });
  }
  return items;
}

export default function ContractQuoteModal({ contract, onClose, onCreated }) {
  const ef = contract.extrafields || {};
  const author = contract.author || {};

  // Détecte civilité depuis le nom (très basique — éditable)
  const inferredTitle = useMemo(() => {
    const n = (author.name || '').toLowerCase();
    if (n.startsWith('mme') || n.startsWith('madame')) return 'Madame';
    return 'Monsieur';
  }, [author.name]);

  // Coercion explicite — les extrafields Dolibarr remontent souvent en string ("0", "100"…).
  // Why: sans parseInt, `ef.authorPurchaseEnabled = "0"` est truthy → branche "enabled"
  // avec qty parsée à 0 → la ligne 4 disparaissait silencieusement.
  const numPages = parseInt(ef.nombrePagesEstime) || 100;
  // Compat anciens contrats : prix stocké en FCFA (souvent 8000–15000) avant la bascule en €.
  // Au-delà de 200 € c'est forcément une valeur FCFA → on convertit.
  const rawPrice = parseFloat(ef.prixPublicPrevisionnel) || 15;
  const numPriceEur = rawPrice > 200 ? Math.round(rawPrice / 655.957 * 100) / 100 : rawPrice;
  const purchaseEnabled = parseInt(ef.authorPurchaseEnabled) === 1;
  const purchaseQty = parseInt(ef.authorPurchaseQty) || 0;
  const initialQty = purchaseEnabled && purchaseQty > 0 ? purchaseQty : 50;
  // Remise auteur réelle du contrat (item 4). Repli sur le défaut pour les
  // anciens contrats sans ce champ. C'EST cette valeur qui pilote le prix d'achat.
  const rawDiscount = parseFloat(ef.authorPurchaseDiscount);
  const purchaseDiscount = Number.isFinite(rawDiscount) && rawDiscount >= 0 && rawDiscount <= 100
    ? rawDiscount
    : DEFAULT_AUTHOR_DISCOUNT;

  const [form, setForm] = useState({
    recipient_title: inferredTitle,
    recipient_name: author.name || '',
    book_title: ef.bookTitle || '',
    book_pages: numPages,
    book_format: '13.5 cm sur 21.5 cm',
    book_interior: 'une couleur N & B',
    book_paper: 'bouffant 80 grammes',
    book_cover: 'cartonné, coucher brillant, quadrichromie avec pellicule',
    book_price_eur: numPriceEur,
    // Remise auteur (%) pré-remplie depuis le contrat mais librement modifiable
    // pour ce devis ; pilote la ligne 4 « Achat de N exemplaires ».
    discount_pct: purchaseDiscount,
    // Nombre d'exemplaires contractuels — la direction garde la main dessus au
    // moment du devis (incrémenter / décrémenter). Pré-rempli depuis le contrat
    // (ou 50 par défaut) ; pilote la ligne 4 « Achat de N exemplaires ».
    copies_qty: initialQty,
    diffusion: 'Dakar, en Afrique de l\'Ouest, à Paris et sur Internet',
    color: false,
  });
  // Format « Autre » : saisie libre dès que la valeur ne fait pas partie des choix figés.
  const [formatCustom, setFormatCustom] = useState(
    () => !FORMAT_OPTIONS.some(o => o.value === form.book_format),
  );
  const [items, setItems] = useState(() => buildDefaultItems({
    pages: parseInt(form.book_pages) || 0,
    priceEur: parseFloat(form.book_price_eur) || 0,
    qty: initialQty,
    color: false,
    discountPct: purchaseDiscount,
  }));

  const [submitting, setSubmitting] = useState(false);

  // Accessibilité : fermeture au clavier (Échap) tant qu'aucune soumission en cours.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Incrémente / décrémente le nombre d'exemplaires contractuels (jamais < 0).
  const adjustCopies = (delta) => setForm(f => ({
    ...f, copies_qty: Math.max(0, (parseInt(f.copies_qty) || 0) + delta),
  }));
  const total = items.reduce((s, i) => s + (parseInt(i.price) || 0), 0);

  // Recalcul auto des items standards (1, 2, 4, 6) quand pages/prix/couleur changent.
  // Why: les lignes 1/2/6 dépendent linéairement du nombre de pages, et la 4
  // dépend du prix public en €. Sans recompute live, l'éditeur changeait les pages
  // et la ligne couleur restait figée à l'ancien total.
  // How to apply: les lignes libres (id >= 100) ne sont jamais écrasées.
  useEffect(() => {
    const pages = parseInt(form.book_pages) || 0;
    const priceEur = parseFloat(form.book_price_eur) || 0;
    const qty = Math.max(0, parseInt(form.copies_qty) || 0);
    setItems(prev => {
      const customs = prev.filter(i => i.id >= 100);
      const next = buildDefaultItems({ pages, priceEur, qty, color: form.color, discountPct: form.discount_pct });
      return [...next, ...customs];
    });
  }, [form.book_pages, form.book_price_eur, form.color, form.discount_pct, form.copies_qty]);

  const updateItem = (idx, patch) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };
  const removeItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx));
  const addCustomItem = () => {
    const nextId = Math.max(100, ...items.map(i => i.id || 0)) + 1;
    setItems(prev => [...prev, { id: nextId, label: '', price: 0 }]);
  };

  const handleSubmit = async () => {
    if (!form.recipient_name?.trim()) return toast.error('Nom destinataire requis');
    if (!form.book_title?.trim()) return toast.error('Titre requis');
    const cleanItems = items
      .map(i => ({ label: String(i.label || '').trim(), price: Math.max(0, parseInt(i.price) || 0) }))
      .filter(i => i.label && i.price > 0);
    if (cleanItems.length === 0) return toast.error('Au moins une ligne avec un montant > 0');

    setSubmitting(true);
    try {
      const res = await createContractQuote(contract.id, {
        recipient_title: form.recipient_title,
        recipient_name: form.recipient_name.trim(),
        book_title: form.book_title.trim(),
        book_pages: parseInt(form.book_pages) || 0,
        book_format: form.book_format,
        book_interior: form.book_interior,
        book_paper: form.book_paper,
        book_cover: form.book_cover,
        book_price_eur: parseFloat(form.book_price_eur) || 0,
        discount_pct: Math.min(100, Math.max(0, parseFloat(form.discount_pct) || 0)),
        // Nombre d'exemplaires contractuels retenu : persisté sur le contrat côté
        // serveur (extrafield author_purchase_qty) pour piloter les prochains devis.
        copies_qty: Math.max(0, parseInt(form.copies_qty) || 0),
        diffusion: form.diffusion,
        items: cleanItems,
      });
      toast.success(`Devis ${res.data.ref} créé`);
      openQuotePdf(res.data.id);
      onCreated?.(res.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création devis');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ct-modal-overlay" onClick={() => !submitting && onClose?.()}>
      <div className="ct-modal ct-modal-large" role="dialog" aria-modal="true" aria-label="Générer un devis" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiFileText size={18} /> Générer un devis
          </h3>
          <button type="button" className="ct-btn-ghost" onClick={onClose}><FiX size={18} /></button>
        </div>

        <div className="ct-quote-form">
          <h5 className="ct-quote-section">Destinataire</h5>
          <div className="ct-form-row cols-2-1">
            <div className="ct-field">
              <label>Nom complet *</label>
              <input value={form.recipient_name} onChange={e => set('recipient_name', e.target.value)} maxLength={120} />
            </div>
            <div className="ct-field">
              <label>Civilité</label>
              <select value={form.recipient_title} onChange={e => set('recipient_title', e.target.value)}>
                <option>Monsieur</option><option>Madame</option><option>Mademoiselle</option>
              </select>
            </div>
          </div>

          <h5 className="ct-quote-section">Spécifications ouvrage</h5>
          <div className="ct-form-row">
            <div className="ct-field">
              <label>Titre *</label>
              <input value={form.book_title} onChange={e => set('book_title', e.target.value)} maxLength={300} />
            </div>
          </div>
          <div className="ct-form-row cols-4">
            <div className="ct-field">
              <label>Pages</label>
              <input type="number" value={form.book_pages} onChange={e => set('book_pages', e.target.value)} min={0} />
            </div>
            <div className="ct-field">
              <label>Format</label>
              <select
                value={formatCustom ? FORMAT_CUSTOM : form.book_format}
                onChange={e => {
                  const v = e.target.value;
                  if (v === FORMAT_CUSTOM) { setFormatCustom(true); set('book_format', ''); }
                  else { setFormatCustom(false); set('book_format', v); }
                }}>
                {FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                <option value={FORMAT_CUSTOM}>Autre format (saisie manuelle)</option>
              </select>
              {formatCustom && (
                <input
                  value={form.book_format}
                  onChange={e => set('book_format', e.target.value)}
                  placeholder="ex. 16 cm sur 24 cm"
                  maxLength={60}
                  style={{ marginTop: 4 }}
                />
              )}
            </div>
            <div className="ct-field">
              <label>Intérieur</label>
              <select value={form.book_interior} onChange={e => set('book_interior', e.target.value)}>
                {INTERIOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="ct-field">
              <label>Papier</label>
              <select value={form.book_paper} onChange={e => set('book_paper', e.target.value)}>
                {PAPER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="ct-form-row cols-3">
            <div className="ct-field">
              <label>Prix public (€)</label>
              <input type="number" step={0.5} value={form.book_price_eur} onChange={e => set('book_price_eur', e.target.value)} min={0} />
            </div>
            <div className="ct-field">
              <label>Remise auteur (%)</label>
              <input type="number" step={1} min={0} max={100}
                value={form.discount_pct}
                onChange={e => set('discount_pct', e.target.value)} />
              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                Sur le prix public — ligne « Achat de N exemplaires »
              </span>
            </div>
            <div className="ct-field">
              <label>Exemplaires contractuels</label>
              <div className="ct-stepper">
                <button type="button" className="ct-stepper-btn" onClick={() => adjustCopies(-1)}
                  disabled={(parseInt(form.copies_qty) || 0) <= 0} aria-label="Retirer un exemplaire">−</button>
                <input type="number" min={0} step={1} value={form.copies_qty}
                  onChange={e => set('copies_qty', e.target.value)} aria-label="Nombre d'exemplaires contractuels" />
                <button type="button" className="ct-stepper-btn" onClick={() => adjustCopies(1)}
                  aria-label="Ajouter un exemplaire">+</button>
              </div>
              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                Quantité de la ligne « Achat de N exemplaires »
              </span>
            </div>
          </div>
          <div className="ct-form-row cols-2">
            <div className="ct-field">
              <label>Couverture</label>
              <input value={form.book_cover} onChange={e => set('book_cover', e.target.value)} maxLength={200} />
            </div>
            <div className="ct-field">
              <label>Diffusion</label>
              <input value={form.diffusion} onChange={e => set('diffusion', e.target.value)} maxLength={200} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input type="checkbox" id="quote-color" checked={form.color} onChange={e => set('color', e.target.checked)} />
            <label htmlFor="quote-color" style={{ fontSize: '0.9rem', cursor: 'pointer' }}>
              Ouvrage en couleur (ajoute « Contribution à l'impression Couleur » = 852 000 FCFA)
            </label>
          </div>

          <h5 className="ct-quote-section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Lignes du devis</span>
            <button type="button" className="ct-btn ct-btn-outline" onClick={addCustomItem} style={{ fontSize: '0.78rem', padding: '4px 10px' }}>
              <FiPlus size={12} /> Ajouter une ligne
            </button>
          </h5>
          <div className="ct-quote-items">
            {items.map((item, idx) => (
              <div key={item.id} className="ct-quote-item-row">
                <input className="ct-quote-item-label" value={item.label}
                  onChange={e => updateItem(idx, { label: e.target.value })}
                  placeholder="Description" maxLength={200} />
                <input className="ct-quote-item-price" type="number" value={item.price}
                  onChange={e => updateItem(idx, { price: e.target.value })} min={0} step={500} />
                <span className="ct-quote-item-unit">FCFA</span>
                <button type="button" className="ct-btn-ghost" onClick={() => removeItem(idx)} title="Supprimer">
                  <FiTrash2 size={14} />
                </button>
              </div>
            ))}
            {items.length === 0 && (
              <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: '8px 0' }}>Aucune ligne — ajoutez-en au moins une.</p>
            )}
          </div>

          <div className="ct-quote-total">
            <span>TOTAL</span>
            <span>{total.toLocaleString('fr-FR')} FCFA</span>
          </div>
        </div>

        <div className="ct-modal-actions">
          <button type="button" className="ct-btn ct-btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button type="button" className="ct-btn ct-btn-primary" onClick={handleSubmit} disabled={submitting || items.length === 0}>
            {submitting ? 'Création...' : <>Créer et télécharger PDF <FiCheckCircle size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
