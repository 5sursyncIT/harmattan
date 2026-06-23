import { useState, useRef, useEffect } from 'react';
import { FiX, FiPlus, FiTrash2, FiSearch, FiUser, FiBookOpen } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { formatPrice } from '../../utils/formatters';
import {
  createSpecialOrder, searchSpecialOrderCustomers, searchSpecialOrderProducts,
} from '../../api/specialOrders';

const METHOD_LABELS = {
  cash: 'Espèces', wave: 'Wave', orange_money: 'Orange Money',
  virement: 'Virement', cb: 'Carte bancaire', cheque: 'Chèque',
};

const emptyLine = () => ({ product_id: null, isbn: '', title: '', author: '', quantity: 1, unit_price: 0 });

export default function SpecialOrderCreateModal({ onClose, onCreated, paymentMethods = ['cash', 'wave', 'orange_money', 'virement', 'cb', 'cheque'] }) {
  const [form, setForm] = useState({
    fk_soc: null, customer_name: '', customer_email: '', customer_phone: '', customer_address: '',
    expected_date: '', delay_estimate: '', notes: '',
    initial_payment: '', payment_method: 'cash', payment_reference: '',
  });
  const [lines, setLines] = useState([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  // Mode de règlement à la commande : aucun | acompte (partiel) | full (intégral).
  const [paymentMode, setPaymentMode] = useState('none');

  // Recherche client
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState([]);
  const custTimer = useRef(null);
  // Recherche produit
  const [prodQuery, setProdQuery] = useState('');
  const [prodResults, setProdResults] = useState([]);
  const prodTimer = useRef(null);

  useEffect(() => () => { clearTimeout(custTimer.current); clearTimeout(prodTimer.current); }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onCustSearch = (q) => {
    setCustQuery(q);
    if (q.trim().length < 2) { setCustResults([]); return; }
    clearTimeout(custTimer.current);
    custTimer.current = setTimeout(() => {
      searchSpecialOrderCustomers(q).then((r) => setCustResults(r.data.customers || [])).catch(() => {});
    }, 300);
  };
  const pickCustomer = (c) => {
    setForm((f) => ({
      ...f, fk_soc: c.id, customer_name: c.name || f.customer_name,
      customer_email: c.email || f.customer_email, customer_phone: c.phone || f.customer_phone,
      customer_address: c.address || f.customer_address,
    }));
    setCustResults([]); setCustQuery('');
  };

  const onProdSearch = (q) => {
    setProdQuery(q);
    if (q.trim().length < 2) { setProdResults([]); return; }
    clearTimeout(prodTimer.current);
    prodTimer.current = setTimeout(() => {
      searchSpecialOrderProducts(q).then((r) => setProdResults(r.data.products || [])).catch(() => {});
    }, 300);
  };
  const addProduct = (p) => {
    setLines((prev) => {
      const next = prev.filter((l) => l.title.trim() || l.isbn.trim());
      next.push({ product_id: p.id, isbn: p.isbn || '', title: p.title || '', author: '', quantity: 1, unit_price: p.price_ttc || 0 });
      return next.length ? next : [emptyLine()];
    });
    setProdResults([]); setProdQuery('');
  };

  const updateLine = (i, k, v) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)));
  const removeLine = (i) => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const validLines = lines.filter((l) => l.title.trim());
  const total = validLines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  const initialPaid = Number(form.initial_payment) || 0;
  const remainingAfter = Math.max(0, total - initialPaid);

  // Synchronise le montant selon le mode : « aucun » → vide, « intégral » → total.
  // En mode « acompte », l'utilisateur saisit librement (avec raccourcis %).
  useEffect(() => {
    if (paymentMode === 'none') setForm((f) => (f.initial_payment === '' ? f : { ...f, initial_payment: '' }));
    else if (paymentMode === 'full') setForm((f) => ({ ...f, initial_payment: total > 0 ? String(Math.round(total)) : '' }));
  }, [paymentMode, total]);

  const validate = () => {
    const e = {};
    if (!form.customer_name.trim()) e.customer_name = 'Nom du client requis';
    if (form.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customer_email)) e.customer_email = 'Email invalide';
    if (validLines.length === 0) e.lines = 'Ajoutez au moins un livre (titre requis)';
    const init = Number(form.initial_payment) || 0;
    if (init < 0) e.initial_payment = 'Montant invalide';
    if (init > total + 0.01) e.initial_payment = 'Le règlement dépasse le total';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload = {
        fk_soc: form.fk_soc,
        customer_name: form.customer_name.trim(),
        customer_email: form.customer_email.trim() || null,
        customer_phone: form.customer_phone.trim() || null,
        customer_address: form.customer_address.trim() || null,
        expected_date: form.expected_date || null,
        delay_estimate: form.delay_estimate.trim() || null,
        notes: form.notes.trim() || null,
        lines: validLines.map((l) => ({
          product_id: l.product_id, isbn: l.isbn.trim() || null, title: l.title.trim(),
          author: l.author.trim() || null, quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price) || 0,
        })),
        initial_payment: Number(form.initial_payment) || 0,
        payment_method: form.payment_method,
        payment_reference: form.payment_reference.trim() || null,
      };
      const r = await createSpecialOrder(payload);
      toast.success(`Commande ${r.data.ref} créée`);
      onCreated?.(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="so-overlay" onClick={onClose}>
      <div className="so-modal lg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="so-modal-head">
          <h3><FiBookOpen /> Nouvelle commande spéciale</h3>
          <button className="so-x" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
        </div>

        {/* CLIENT */}
        <div className="so-section">
          <p className="so-section-title">Client</p>
          <div className="so-field so-ac">
            <label>Rechercher un client existant (tiers Dolibarr)</label>
            <div style={{ position: 'relative' }}>
              <FiSearch size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              <input style={{ paddingLeft: 34 }} value={custQuery} onChange={(e) => onCustSearch(e.target.value)} placeholder="Nom, téléphone, email..." />
            </div>
            {custResults.length > 0 && (
              <div className="so-ac-results">
                {custResults.map((c) => (
                  <div key={c.id} className="so-ac-item" onClick={() => pickCustomer(c)}>
                    <FiUser size={12} style={{ verticalAlign: -1, marginRight: 6, color: '#10531a' }} />
                    <strong>{c.name}</strong> {c.phone ? <small>· {c.phone}</small> : ''} {c.email ? <small>· {c.email}</small> : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
          {form.fk_soc && <p style={{ fontSize: '0.78rem', color: '#166534', margin: '-4px 0 8px' }}>Tiers Dolibarr lié (#{form.fk_soc})</p>}
          <div className="so-grid2">
            <div className="so-field">
              <label>Nom du client *</label>
              <input value={form.customer_name} onChange={(e) => { set('customer_name', e.target.value); set('fk_soc', form.fk_soc); }} placeholder="Prénom Nom" />
              {errors.customer_name && <div className="so-err">{errors.customer_name}</div>}
            </div>
            <div className="so-field">
              <label>Téléphone</label>
              <input value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="77 000 00 00" />
            </div>
            <div className="so-field">
              <label>Email</label>
              <input value={form.customer_email} onChange={(e) => set('customer_email', e.target.value)} placeholder="client@email.com" />
              {errors.customer_email && <div className="so-err">{errors.customer_email}</div>}
            </div>
            <div className="so-field">
              <label>Adresse</label>
              <input value={form.customer_address} onChange={(e) => set('customer_address', e.target.value)} placeholder="Quartier, ville" />
            </div>
          </div>
        </div>

        {/* LIVRES */}
        <div className="so-section">
          <p className="so-section-title">Ouvrages demandés</p>
          <div className="so-field so-ac">
            <div style={{ position: 'relative' }}>
              <FiSearch size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              <input style={{ paddingLeft: 34 }} value={prodQuery} onChange={(e) => onProdSearch(e.target.value)} placeholder="Rechercher un livre au catalogue (titre, ISBN)..." />
            </div>
            {prodResults.length > 0 && (
              <div className="so-ac-results">
                {prodResults.map((p) => (
                  <div key={p.id} className="so-ac-item" onClick={() => addProduct(p)}>
                    <FiPlus size={12} style={{ verticalAlign: -1, marginRight: 6, color: '#10531a' }} />
                    <strong>{p.title}</strong> {p.isbn ? <small>· {p.isbn}</small> : ''} {p.price_ttc ? <small>· {formatPrice(p.price_ttc)}</small> : ''}
                  </div>
                ))}
              </div>
            )}
          </div>

          {lines.map((l, i) => (
            <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, marginBottom: 8, background: '#fafafa' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input style={{ flex: 1, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontWeight: 600 }}
                  value={l.title} onChange={(e) => updateLine(i, 'title', e.target.value)} placeholder="Titre de l'ouvrage *" />
                <button className="so-line-del" onClick={() => removeLine(i)} aria-label="Retirer" title="Retirer cette ligne"><FiTrash2 size={16} /></button>
              </div>
              <div className="so-grid2" style={{ marginTop: 8 }}>
                <input style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: '0.85rem' }}
                  value={l.author} onChange={(e) => updateLine(i, 'author', e.target.value)} placeholder="Auteur" />
                <input style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: '0.85rem' }}
                  value={l.isbn} onChange={(e) => updateLine(i, 'isbn', e.target.value)} placeholder="ISBN" />
              </div>
              <div className="so-grid3" style={{ marginTop: 8, alignItems: 'end' }}>
                <div>
                  <label style={{ fontSize: '0.74rem', color: '#64748b' }}>Quantité</label>
                  <input type="number" min="1" style={{ width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: '0.85rem' }}
                    value={l.quantity} onChange={(e) => updateLine(i, 'quantity', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.74rem', color: '#64748b' }}>Prix unitaire (FCFA)</label>
                  <input type="number" min="0" style={{ width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: '0.85rem' }}
                    value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} />
                </div>
                <div style={{ textAlign: 'right' }}>
                  <label style={{ fontSize: '0.74rem', color: '#64748b', display: 'block' }}>Sous-total</label>
                  <span style={{ fontWeight: 700 }}>{formatPrice((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}</span>
                </div>
              </div>
            </div>
          ))}
          {errors.lines && <div className="so-err" style={{ marginBottom: 6 }}>{errors.lines}</div>}
          <button className="btn btn-outline btn-sm" onClick={() => setLines((p) => [...p, emptyLine()])}><FiPlus size={14} /> Ajouter une ligne libre</button>

          <div className="so-money-line total" style={{ marginTop: 12 }}>
            <span>Total commande</span><span>{formatPrice(total)}</span>
          </div>
        </div>

        {/* DÉLAI */}
        <div className="so-section">
          <p className="so-section-title">Disponibilité</p>
          <div className="so-grid2">
            <div className="so-field">
              <label>Date prévue de disponibilité</label>
              <input type="date" value={form.expected_date} onChange={(e) => set('expected_date', e.target.value)} />
            </div>
            <div className="so-field">
              <label>Délai estimé (texte libre)</label>
              <input value={form.delay_estimate} onChange={(e) => set('delay_estimate', e.target.value)} placeholder="ex. 2 à 3 semaines" />
            </div>
          </div>
          <div className="so-field">
            <label>Note interne</label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Précisions sur la commande..." />
          </div>
        </div>

        {/* RÈGLEMENT À LA COMMANDE — mode (aucun / acompte / intégral) */}
        <div className="so-section">
          <p className="so-section-title">Règlement à la commande</p>
          <div className="so-actions" style={{ marginBottom: 10 }}>
            <button type="button" className={`btn btn-sm ${paymentMode === 'none' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPaymentMode('none')}>
              Aucun (régler plus tard)
            </button>
            <button type="button" className={`btn btn-sm ${paymentMode === 'acompte' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPaymentMode('acompte')} disabled={total <= 0}>
              Acompte
            </button>
            <button type="button" className={`btn btn-sm ${paymentMode === 'full' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPaymentMode('full')} disabled={total <= 0}>
              Paiement intégral
            </button>
          </div>

          {paymentMode !== 'none' && (
            <>
              {paymentMode === 'acompte' && (
                <div className="so-actions" style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: '0.8rem', color: '#64748b', alignSelf: 'center' }}>Acompte rapide :</span>
                  {[0.25, 0.3, 0.5, 0.75].map((fr) => (
                    <button type="button" key={fr} className="btn btn-outline btn-sm" onClick={() => set('initial_payment', String(Math.round(total * fr)))}>
                      {Math.round(fr * 100)} %
                    </button>
                  ))}
                </div>
              )}
              <div className="so-grid3">
                <div className="so-field">
                  <label>{paymentMode === 'full' ? 'Montant (intégral)' : "Montant de l'acompte"}</label>
                  <input type="number" min="0" value={form.initial_payment} readOnly={paymentMode === 'full'}
                    onChange={(e) => set('initial_payment', e.target.value)} placeholder="0"
                    style={paymentMode === 'full' ? { background: '#f8fafc' } : undefined} />
                  {errors.initial_payment && <div className="so-err">{errors.initial_payment}</div>}
                </div>
                <div className="so-field">
                  <label>Méthode</label>
                  <select value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
                    {paymentMethods.map((m) => <option key={m} value={m}>{METHOD_LABELS[m] || m}</option>)}
                  </select>
                </div>
                <div className="so-field">
                  <label>Référence</label>
                  <input value={form.payment_reference} onChange={(e) => set('payment_reference', e.target.value)} placeholder="N° transaction" />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: '0.86rem', padding: '8px 12px', background: '#f8fafc', borderRadius: 8 }}>
                <span style={{ color: '#166534' }}>{paymentMode === 'full' ? 'Réglé' : 'Acompte'} : <strong>{formatPrice(initialPaid)}</strong></span>
                <span style={{ color: remainingAfter > 0 ? '#b45309' : '#166534' }}>
                  {remainingAfter > 0 ? <>Reste à payer : <strong>{formatPrice(remainingAfter)}</strong></> : <strong>Soldée à la commande</strong>}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="so-modal-foot">
          <button className="btn btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Création…' : 'Créer la commande'}
          </button>
        </div>
      </div>
    </div>
  );
}
