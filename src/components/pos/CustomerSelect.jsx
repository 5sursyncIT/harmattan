import { useState, useRef } from 'react';
import { posSearchCustomers, posCreateCustomer, posPromoteAuthorToCustomer } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import { FiX, FiSearch, FiUser, FiUserPlus, FiBookOpen } from 'react-icons/fi';
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

  const handleSelect = async (c) => {
    // Auteur local sans tier Dolibarr → on le promeut (création + lien)
    // avant de l'utiliser, sinon la vente repartirait sur le client comptoir.
    if (c.source === 'author_pending' && c.author_id) {
      try {
        const res = await posPromoteAuthorToCustomer(c.author_id);
        setCustomer({ ...res.data, source: 'author' });
        toast.success(`${res.data.name} ajouté comme client`);
        onClose();
        return;
      } catch (err) {
        toast.error(err.response?.data?.error || 'Erreur ajout auteur');
        return;
      }
    }
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
              {results.map((c, idx) => {
                const isAuthor = c.source === 'author' || c.source === 'author_pending';
                const pending = c.source === 'author_pending';
                return (
                  <button
                    key={c.id ?? `author-${c.author_id ?? idx}`}
                    className="pos-cust-result"
                    onClick={() => handleSelect(c)}
                  >
                    <span className="pos-cust-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {isAuthor && <FiBookOpen size={12} style={{ color: '#7c3aed' }} />}
                      {c.name}
                      {isAuthor && (
                        <span style={{
                          background: pending ? '#fef3c7' : '#ede9fe',
                          color: pending ? '#92400e' : '#6d28d9',
                          padding: '1px 6px', borderRadius: 10,
                          fontSize: 10, fontWeight: 700,
                        }}>
                          {pending ? 'AUTEUR (à lier)' : 'AUTEUR'}
                        </span>
                      )}
                    </span>
                    <span className="pos-cust-detail">{c.email || c.phone}</span>
                  </button>
                );
              })}
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
