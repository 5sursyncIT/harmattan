import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  FiLogOut, FiUser, FiPackage, FiLock, FiFileText,
  FiMail, FiPhone, FiMapPin, FiEdit2, FiSave, FiX, FiEye, FiDownload
} from 'react-icons/fi';
import useAuthStore from '../store/authStore';
import { updateProfile, changePassword, getCustomerOrders, getCustomerInvoices, getInvoicePdfUrl } from '../api/dolibarr';
import { formatPrice } from '../utils/formatters';
import toast from 'react-hot-toast';
import './AccountPage.css';

const STATUS_LABELS = {
  '-1': 'Annulée',
  '0': 'Brouillon',
  '1': 'Validée',
  '2': 'En traitement',
  '3': 'Expédiée',
};

const STATUS_COLORS = {
  '-1': '#ef4444',
  '0': '#9ca3af',
  '1': '#10b981',
  '2': '#f97316',
  '3': '#3b82f6',
};

export default function AccountPage() {
  const navigate = useNavigate();
  const { customer, isAuthenticated, logout, updateCustomer } = useAuthStore();
  const [activeTab, setActiveTab] = useState('profile');

  if (!isAuthenticated) {
    navigate('/connexion');
    return null;
  }

  const handleLogout = () => {
    logout();
    toast.success('Déconnexion réussie');
    navigate('/');
  };

  return (
    <div className="account-page">
      <div className="container">
        <div className="account-layout">
          <aside className="account-sidebar">
            <div className="account-sidebar-header">
              <div className="account-avatar">
                <FiUser size={24} />
              </div>
              <div>
                <h3>{customer.firstname || customer.name}</h3>
                <p>{customer.email}</p>
              </div>
            </div>

            <nav className="account-nav">
              <button className={activeTab === 'profile' ? 'active' : ''} onClick={() => setActiveTab('profile')}>
                <FiUser size={16} /> Mon profil
              </button>
              <button className={activeTab === 'orders' ? 'active' : ''} onClick={() => setActiveTab('orders')}>
                <FiPackage size={16} /> Commandes
              </button>
              <button className={activeTab === 'invoices' ? 'active' : ''} onClick={() => setActiveTab('invoices')}>
                <FiFileText size={16} /> Factures
              </button>
              <button className={activeTab === 'password' ? 'active' : ''} onClick={() => setActiveTab('password')}>
                <FiLock size={16} /> Mot de passe
              </button>
            </nav>

            <button className="account-logout" onClick={handleLogout}>
              <FiLogOut size={16} /> Déconnexion
            </button>
          </aside>

          <div className="account-content">
            {activeTab === 'profile' && <ProfileTab customer={customer} updateCustomer={updateCustomer} />}
            {activeTab === 'orders' && <OrdersTab customerId={customer.id} />}
            {activeTab === 'invoices' && <InvoicesTab customerId={customer.id} />}
            {activeTab === 'password' && <PasswordTab customerId={customer.id} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileTab({ customer, updateCustomer }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    firstname: customer.firstname || '',
    lastname: customer.lastname || customer.name?.split(' ').slice(1).join(' ') || '',
    email: customer.email || '',
    phone: customer.phone || '',
    address: customer.address || '',
    city: customer.town || 'Dakar',
  });

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSave = async () => {
    setLoading(true);
    try {
      const res = await updateProfile({ id: customer.id, ...form });
      updateCustomer(res.data);
      setEditing(false);
      toast.success('Profil mis à jour');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de mise à jour');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="account-tab">
      <div className="tab-header">
        <h2>Mon profil</h2>
        {!editing ? (
          <button className="btn btn-sm btn-outline" onClick={() => setEditing(true)}>
            <FiEdit2 size={14} /> Modifier
          </button>
        ) : (
          <div className="tab-header-actions">
            <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={loading}>
              <FiSave size={14} /> {loading ? 'Enregistrement...' : 'Enregistrer'}
            </button>
            <button className="btn btn-sm btn-outline" onClick={() => setEditing(false)}>
              <FiX size={14} /> Annuler
            </button>
          </div>
        )}
      </div>

      <div className="profile-grid">
        <div className="profile-field">
          <label><FiUser size={14} /> Prénom</label>
          {editing ? (
            <input name="firstname" value={form.firstname} onChange={handleChange} />
          ) : (
            <p>{customer.firstname || '-'}</p>
          )}
        </div>
        <div className="profile-field">
          <label><FiUser size={14} /> Nom</label>
          {editing ? (
            <input name="lastname" value={form.lastname} onChange={handleChange} />
          ) : (
            <p>{customer.lastname || customer.name?.split(' ').slice(1).join(' ') || '-'}</p>
          )}
        </div>
        <div className="profile-field">
          <label><FiMail size={14} /> Email</label>
          {editing ? (
            <input name="email" type="email" value={form.email} onChange={handleChange} />
          ) : (
            <p>{customer.email || '-'}</p>
          )}
        </div>
        <div className="profile-field">
          <label><FiPhone size={14} /> Téléphone</label>
          {editing ? (
            <input name="phone" value={form.phone} onChange={handleChange} placeholder="+221 7X XXX XX XX" />
          ) : (
            <p>{customer.phone || 'Non renseigné'}</p>
          )}
        </div>
        <div className="profile-field full">
          <label><FiMapPin size={14} /> Adresse</label>
          {editing ? (
            <input name="address" value={form.address} onChange={handleChange} placeholder="Adresse de livraison" />
          ) : (
            <p>{customer.address || 'Non renseignée'}</p>
          )}
        </div>
        <div className="profile-field">
          <label><FiMapPin size={14} /> Ville</label>
          {editing ? (
            <input name="city" value={form.city} onChange={handleChange} />
          ) : (
            <p>{customer.town || 'Dakar'}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function OrdersTab({ customerId }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState(null);

  useEffect(() => {
    getCustomerOrders(customerId)
      .then((res) => setOrders(Array.isArray(res.data) ? res.data : []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, [customerId]);

  if (loading) {
    return (
      <div className="account-tab">
        <h2>Mes commandes</h2>
        <div className="orders-loading">
          {[1, 2, 3].map((i) => (
            <div key={i} className="order-skeleton">
              <div className="skeleton-line w60" />
              <div className="skeleton-line w40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="account-tab">
      <h2>Mes commandes</h2>

      {orders.length === 0 ? (
        <div className="orders-empty">
          <FiPackage size={40} />
          <p>Vous n'avez pas encore de commande</p>
          <Link to="/catalogue" className="btn btn-primary">Découvrir le catalogue</Link>
        </div>
      ) : (
        <div className="orders-list">
          {orders.map((order) => (
            <div key={order.id} className="order-card">
              <div className="order-header" onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}>
                <div className="order-info">
                  <span className="order-ref">{order.ref}</span>
                  <span className="order-date">
                    {new Date(order.date_creation).toLocaleDateString('fr-FR', {
                      day: 'numeric', month: 'long', year: 'numeric'
                    })}
                  </span>
                </div>
                <div className="order-meta">
                  <span className="order-total">{formatPrice(order.total_ttc)}</span>
                  <span className="order-status" style={{ background: `${STATUS_COLORS[order.statut]}20`, color: STATUS_COLORS[order.statut] }}>
                    {STATUS_LABELS[order.statut] || 'Inconnue'}
                  </span>
                  <FiEye size={14} className="order-toggle" />
                </div>
              </div>

              {expandedOrder === order.id && order.lines && (
                <div className="order-details">
                  <table>
                    <thead>
                      <tr>
                        <th>Produit</th>
                        <th>Qté</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.lines.map((line, idx) => (
                        <tr key={idx}>
                          <td>
                            {line.fk_product ? (
                              <Link to={`/produit/${line.fk_product}`}>{line.product_label}</Link>
                            ) : (
                              line.product_label
                            )}
                          </td>
                          <td>{line.qty}</td>
                          <td>{formatPrice(line.total_ttc)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const INVOICE_STATUS_LABELS = {
  '0': 'Brouillon',
  '1': 'Non payée',
  '2': 'Payée',
  '3': 'Abandonnée',
};

const INVOICE_STATUS_COLORS = {
  '0': '#9ca3af',
  '1': '#f97316',
  '2': '#10b981',
  '3': '#ef4444',
};

function InvoicesTab({ customerId }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCustomerInvoices(customerId)
      .then((res) => setInvoices(Array.isArray(res.data) ? res.data : []))
      .catch(() => setInvoices([]))
      .finally(() => setLoading(false));
  }, [customerId]);

  if (loading) {
    return (
      <div className="account-tab">
        <h2>Mes factures</h2>
        <div className="orders-loading">
          {[1, 2, 3].map((i) => (
            <div key={i} className="order-skeleton">
              <div className="skeleton-line w60" />
              <div className="skeleton-line w40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="account-tab">
      <h2>Mes factures</h2>

      {invoices.length === 0 ? (
        <div className="orders-empty">
          <FiFileText size={40} />
          <p>Vous n'avez pas encore de facture</p>
          <Link to="/catalogue" className="btn btn-primary">Découvrir le catalogue</Link>
        </div>
      ) : (
        <div className="orders-list">
          {invoices.map((inv) => (
            <div key={inv.id} className="order-card">
              <div className="order-header">
                <div className="order-info">
                  <span className="order-ref">{inv.ref}</span>
                  <span className="order-date">
                    {new Date((inv.date_creation || inv.date) * 1000).toLocaleDateString('fr-FR', {
                      day: 'numeric', month: 'long', year: 'numeric'
                    })}
                  </span>
                </div>
                <div className="order-meta">
                  <span className="order-total">{formatPrice(inv.total_ttc)}</span>
                  <span className="order-status" style={{ background: `${INVOICE_STATUS_COLORS[inv.statut]}20`, color: INVOICE_STATUS_COLORS[inv.statut] }}>
                    {inv.paye === '1' ? 'Payée' : (INVOICE_STATUS_LABELS[inv.statut] || 'Inconnue')}
                  </span>
                  <a
                    href={getInvoicePdfUrl(inv.id)}
                    className="btn btn-sm btn-outline"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FiDownload size={13} /> PDF
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PasswordTab({ customerId }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    if (errors[e.target.name]) setErrors({ ...errors, [e.target.name]: '' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.currentPassword) errs.currentPassword = 'Requis';
    if (!form.newPassword) errs.newPassword = 'Requis';
    else if (form.newPassword.length < 6) errs.newPassword = 'Minimum 6 caractères';
    if (form.newPassword !== form.confirmPassword) errs.confirmPassword = 'Les mots de passe ne correspondent pas';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);
    try {
      await changePassword({
        id: customerId,
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      toast.success('Mot de passe modifié');
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de changement de mot de passe');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="account-tab">
      <h2>Changer le mot de passe</h2>

      <form className="password-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Mot de passe actuel</label>
          <input type="password" name="currentPassword" value={form.currentPassword} onChange={handleChange} />
          {errors.currentPassword && <span className="field-error">{errors.currentPassword}</span>}
        </div>
        <div className="form-group">
          <label>Nouveau mot de passe</label>
          <input type="password" name="newPassword" value={form.newPassword} onChange={handleChange} placeholder="Minimum 6 caractères" />
          {errors.newPassword && <span className="field-error">{errors.newPassword}</span>}
        </div>
        <div className="form-group">
          <label>Confirmer le nouveau mot de passe</label>
          <input type="password" name="confirmPassword" value={form.confirmPassword} onChange={handleChange} />
          {errors.confirmPassword && <span className="field-error">{errors.confirmPassword}</span>}
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          <FiLock size={14} /> {loading ? 'Modification...' : 'Modifier le mot de passe'}
        </button>
      </form>
    </div>
  );
}
