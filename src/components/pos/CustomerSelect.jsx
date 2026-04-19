import { useState, useRef } from 'react';
import { posSearchCustomers, posCreateCustomer } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import { FiX, FiSearch, FiUser, FiUserPlus } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './CustomerSelect.css';

export default function CustomerSelect({ onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const setCustomer = usePosCartStore((s) => s.setCustomer);
  const timer = useRef(null);

  const doSearch = (q) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    posSearchCustomers(q)
      .then((res) => setResults(res.data))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  };

  const handleChange = (e) => {
    setQuery(e.target.value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => doSearch(e.target.value), 300);
  };

  const handleSelect = (c) => {
    setCustomer(c);
    onClose();
  };

  const handleWalkIn = () => {
    setCustomer(null);
    onClose();
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await posCreateCustomer({ name: newName.trim(), phone: newPhone, email: newEmail });
      toast.success(`Client "${res.data.name}" créé`);
      handleSelect(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création client');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="pos-cust-overlay">
      <div className="pos-cust-panel">
        <div className="pos-cust-header">
          <h3>{showCreate ? 'Nouveau client' : 'Sélectionner un client'}</h3>
          <button onClick={onClose}><FiX size={20} /></button>
        </div>

        {!showCreate ? (
          <>
            <div className="pos-cust-search">
              <FiSearch />
              <input
                type="text"
                placeholder="Nom, email ou téléphone..."
                value={query}
                onChange={handleChange}
                autoFocus
              />
            </div>

            <div className="pos-cust-actions">
              <button className="pos-cust-walkin" onClick={handleWalkIn}>
                <FiUser /> Client comptoir
              </button>
              <button className="pos-cust-create-btn" onClick={() => setShowCreate(true)}>
                <FiUserPlus /> Nouveau client
              </button>
            </div>

            <div className="pos-cust-results">
              {loading && <div className="pos-cust-loading">Recherche...</div>}
              {results.map((c) => (
                <button key={c.id} className="pos-cust-result" onClick={() => handleSelect(c)}>
                  <span className="pos-cust-name">{c.name}</span>
                  <span className="pos-cust-detail">{c.email || c.phone}</span>
                </button>
              ))}
              {!loading && query.length >= 2 && results.length === 0 && (
                <div className="pos-cust-empty">Aucun client trouvé</div>
              )}
            </div>
          </>
        ) : (
          <form className="pos-cust-form" onSubmit={handleCreate}>
            <div className="pos-cust-field">
              <label>Nom *</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nom complet" autoFocus required />
            </div>
            <div className="pos-cust-field">
              <label>Téléphone</label>
              <input type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="77 000 00 00" />
            </div>
            <div className="pos-cust-field">
              <label>Email</label>
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email@exemple.com" />
            </div>
            <div className="pos-cust-form-actions">
              <button type="button" className="pos-cust-cancel" onClick={() => setShowCreate(false)}>Retour</button>
              <button type="submit" className="pos-cust-submit" disabled={creating}>
                {creating ? 'Création...' : 'Créer et sélectionner'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
