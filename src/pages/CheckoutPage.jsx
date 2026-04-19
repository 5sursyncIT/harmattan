import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FiCheck, FiSend } from 'react-icons/fi';
import useCartStore from '../store/cartStore';
import useAuthStore from '../store/authStore';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import api, { createOrder } from '../api/dolibarr';
import { formatPrice } from '../utils/formatters';
import toast from 'react-hot-toast';
import './CheckoutPage.css';

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { items, getTotal, clearCart } = useCartStore();
  const { customer, isAuthenticated } = useAuthStore();
  const config = useSiteConfig();
  const PAYMENT_METHODS = (config?.payment_methods || []).filter(m => m.enabled);
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [orderComplete, setOrderComplete] = useState(false);
  const [orderResult, setOrderResult] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [proofRef, setProofRef] = useState('');
  const [proofPhone, setProofPhone] = useState('');
  const [proofSending, setProofSending] = useState(false);
  const [proofSent, setProofSent] = useState(false);

  const [form, setForm] = useState({
    firstname: customer?.firstname || '',
    lastname: customer?.lastname || customer?.name?.split(' ').slice(1).join(' ') || '',
    email: customer?.email || '',
    phone: customer?.phone || '',
    address: customer?.address || '',
    city: customer?.town || 'Dakar',
    country: 'Sénégal',
  });

  if (items.length === 0 && !orderComplete) {
    navigate('/panier');
    return null;
  }

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }
    if (step === 2 && !paymentMethod) {
      toast.error('Veuillez choisir un moyen de paiement');
      return;
    }

    setSubmitting(true);
    try {
      const orderRes = await createOrder({
        customer: {
          dolibarr_id: customer?.id || null,
          firstname: form.firstname,
          lastname: form.lastname,
          email: form.email,
          phone: form.phone,
        },
        items: items.map((item) => ({
          id: item.id,
          quantity: item.quantity,
          price_ttc: item.price_ttc,
        })),
        payment_method: paymentMethod,
        shipping_address: {
          address: form.address,
          city: form.city,
          country: form.country,
        },
      });

      setOrderResult(orderRes.data);
      setOrderComplete(true);
      clearCart();
      toast.success(`Commande ${orderRes.data.order_ref} enregistrée !`);
    } catch (err) {
      console.error('Order error:', err);
      toast.error('Erreur lors de la commande. Veuillez réessayer.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendProof = async () => {
    if (!proofRef.trim()) return toast.error('Veuillez entrer la référence de transaction');
    setProofSending(true);
    try {
      await api.post(`/orders/${orderResult?.order_id}/payment-proof`, {
        transaction_ref: proofRef.trim(),
        payer_phone: proofPhone.trim(),
      });
      setProofSent(true);
      toast.success('Référence envoyée ! Nous vérifions votre paiement.');
    } catch {
      toast.error('Erreur lors de l\'envoi');
    } finally {
      setProofSending(false);
    }
  };

  if (orderComplete) {
    const method = PAYMENT_METHODS.find(m => m.id === paymentMethod);
    return (
      <div className="checkout-page">
        <div className="container order-success">
          <div className="success-icon"><FiCheck size={48} /></div>
          <h2>Commande enregistrée !</h2>
          <p>Référence : <strong>{orderResult?.order_ref}</strong> — Montant : <strong>{formatPrice(orderResult?.total)}</strong></p>

          {/* Instructions de paiement */}
          {method?.instructions && (
            <div className="payment-instructions">
              <h3>{method.icon} Payez par {method.label}</h3>
              {method.instructions.split('\n').map((line, i) => (
                <p key={i} dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
              ))}
              <p style={{ fontWeight: 700, color: '#10531a', fontSize: '1.1rem', marginTop: 12 }}>
                Montant exact à envoyer : {formatPrice(orderResult?.total)}
              </p>
            </div>
          )}

          {/* Formulaire de preuve de paiement */}
          {!proofSent ? (
            <div className="payment-proof-form" style={{ background: '#f8fafc', borderRadius: 12, padding: 20, marginTop: 20, border: '1px solid #e2e8f0', textAlign: 'left' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}><FiSend size={16} style={{ verticalAlign: -2 }} /> J'ai effectué le paiement</h3>
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: 16 }}>
                Après avoir envoyé l'argent, entrez votre référence de transaction pour accélérer la vérification.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Référence de transaction *</label>
                  <input type="text" value={proofRef} onChange={e => setProofRef(e.target.value)}
                    placeholder="Ex: WAV-123456789 ou code reçu par SMS"
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '2px solid #e5e7eb', fontSize: '0.95rem' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Numéro qui a payé</label>
                  <input type="tel" value={proofPhone} onChange={e => setProofPhone(e.target.value)}
                    placeholder="Ex: 77 123 45 67"
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '2px solid #e5e7eb', fontSize: '0.95rem' }} />
                </div>
                <button onClick={handleSendProof} disabled={proofSending}
                  style={{ padding: '12px', borderRadius: 10, border: 'none', background: '#10531a', color: '#fff', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}>
                  {proofSending ? 'Envoi...' : 'Confirmer mon paiement'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ background: '#f0fdf4', borderRadius: 12, padding: 20, marginTop: 20, border: '1px solid #bbf7d0', textAlign: 'center' }}>
              <FiCheck size={32} style={{ color: '#10b981', marginBottom: 8 }} />
              <p style={{ fontWeight: 700, color: '#166534', margin: '0 0 4px' }}>Référence envoyée</p>
              <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>
                Nous vérifions votre paiement. Vous recevrez une confirmation par email sous peu.
              </p>
            </div>
          )}

          <button className="btn btn-outline" onClick={() => navigate('/')} style={{ marginTop: 16 }}>
            Retour à l'accueil
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <div className="container">
        <h1>Commander</h1>

        {!isAuthenticated && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.9rem' }}>Déjà client ? <Link to="/connexion" style={{ fontWeight: 700, color: '#10531a' }}>Connectez-vous</Link> pour pré-remplir vos informations.</span>
          </div>
        )}

        {/* Progress */}
        <div className="checkout-steps">
          <div className={`checkout-step ${step >= 1 ? 'active' : ''}`}>
            <span>1</span> Informations
          </div>
          <div className={`checkout-step ${step >= 2 ? 'active' : ''}`}>
            <span>2</span> Paiement
          </div>
          <div className={`checkout-step ${step >= 3 ? 'active' : ''}`}>
            <span>3</span> Confirmation
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="checkout-layout">
            <div className="checkout-form">
              {step === 1 && (
                <div className="form-section">
                  <h3>Informations de livraison</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Prénom *</label>
                      <input name="firstname" value={form.firstname} onChange={handleChange} required />
                    </div>
                    <div className="form-group">
                      <label>Nom *</label>
                      <input name="lastname" value={form.lastname} onChange={handleChange} required />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Email *</label>
                      <input name="email" type="email" value={form.email} onChange={handleChange} required />
                    </div>
                    <div className="form-group">
                      <label>Téléphone *</label>
                      <input name="phone" value={form.phone} onChange={handleChange} required placeholder="+221 7X XXX XX XX" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Adresse *</label>
                    <input name="address" value={form.address} onChange={handleChange} required />
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Ville *</label>
                      <input name="city" value={form.city} onChange={handleChange} required />
                    </div>
                    <div className="form-group">
                      <label>Pays</label>
                      <input name="country" value={form.country} disabled />
                    </div>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="form-section">
                  <h3>Moyen de paiement</h3>
                  <div className="payment-methods">
                    {PAYMENT_METHODS.map((pm) => (
                      <label
                        key={pm.id}
                        className={`payment-option ${paymentMethod === pm.id ? 'selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="payment"
                          value={pm.id}
                          checked={paymentMethod === pm.id}
                          onChange={(e) => setPaymentMethod(e.target.value)}
                        />
                        <span className="payment-icon">{pm.icon}</span>
                        <span className="payment-label">{pm.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="checkout-summary">
              <h3>Votre commande</h3>
              {items.map((item) => (
                <div key={item.id} className="checkout-item">
                  <span className="checkout-item-name">
                    {item.label} <em>&times;{item.quantity}</em>
                  </span>
                  <span>{formatPrice(parseFloat(item.price_ttc) * item.quantity)}</span>
                </div>
              ))}
              <div className="checkout-total">
                <span>Total</span>
                <span>{formatPrice(getTotal())}</span>
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-lg"
                style={{ width: '100%' }}
                disabled={submitting}
              >
                {submitting ? 'Traitement...' : step === 1 ? 'Continuer' : 'Confirmer la commande'}
              </button>
              {step === 2 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={() => setStep(1)}
                >
                  Retour
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
