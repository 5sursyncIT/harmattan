import { useState } from 'react';
import { posOpenSession, posCloseSession, posCashInOut } from '../../api/pos';
import usePosSessionStore from '../../store/posSessionStore';
import usePosAuthStore from '../../store/posAuthStore';
import { FiX, FiLogIn, FiLogOut, FiPlus, FiMinus } from 'react-icons/fi';
import './CashRegister.css';

export default function CashRegister({ session, onClose, onUpdate }) {
  const [tab, setTab] = useState(session ? 'operations' : 'open');
  const [openingCash, setOpeningCash] = useState('');
  const [closingData, setClosingData] = useState({ cash: '', card: '', cheque: '', wave: '', om: '' });
  const [moveType, setMoveType] = useState('in');
  const [moveAmount, setMoveAmount] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const openSessionStore = usePosSessionStore((s) => s.openSession);
  const closeSessionStore = usePosSessionStore((s) => s.closeSession);
  const staff = usePosAuthStore((s) => s.staff);

  const handleOpen = async () => {
    setLoading(true); setError('');
    try {
      const res = await posOpenSession({ opening_cash: parseInt(openingCash) || 0 });
      openSessionStore(res.data);
      onUpdate();
      setTab('operations');
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur ouverture');
    } finally { setLoading(false); }
  };

  const handleClose = async () => {
    setLoading(true); setError('');
    try {
      const res = await posCloseSession({
        session_id: session?.id,
        counted_cash: parseInt(closingData.cash) || 0,
        counted_card: parseInt(closingData.card) || 0,
        counted_cheque: parseInt(closingData.cheque) || 0,
        counted_wave: parseInt(closingData.wave) || 0,
        counted_om: parseInt(closingData.om) || 0,
      });
      setResult(res.data);
      closeSessionStore();
      onUpdate();
      setTab('result');
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur clôture');
    } finally { setLoading(false); }
  };

  const handleCashMove = async () => {
    if (!moveAmount) return;
    setLoading(true); setError('');
    try {
      await posCashInOut({
        session_id: session?.id,
        type: moveType,
        amount: parseInt(moveAmount),
        reason: moveReason,
      });
      setMoveAmount(''); setMoveReason('');
      onUpdate();
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur mouvement');
    } finally { setLoading(false); }
  };

  return (
    <div className="pos-cr-overlay">
      <div className="pos-cr-panel">
        <div className="pos-cr-header">
          <h3>Gestion de caisse</h3>
          <button onClick={onClose}><FiX size={20} /></button>
        </div>

        {!session && tab !== 'result' && (
          <div className="pos-cr-tab-content">
            <p className="pos-cr-info">Aucune session ouverte. Saisissez le fond de caisse.</p>
            <div className="pos-cr-field">
              <label>Fond de caisse (espèces)</label>
              <input type="number" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} placeholder="0" />
            </div>
            {error && <div className="pos-cr-error">{error}</div>}
            <button className="pos-cr-btn primary" onClick={handleOpen} disabled={loading}>
              <FiLogIn /> {loading ? 'Ouverture...' : 'Ouvrir la caisse'}
            </button>
          </div>
        )}

        {session && tab === 'operations' && (
          <div className="pos-cr-tab-content">
            <div className="pos-cr-tabs">
              <button className={moveType === 'in' ? 'active' : ''} onClick={() => setMoveType('in')}>
                <FiPlus /> Entrée
              </button>
              <button className={moveType === 'out' ? 'active' : ''} onClick={() => setMoveType('out')}>
                <FiMinus /> Sortie
              </button>
            </div>
            <div className="pos-cr-field">
              <label>Montant</label>
              <input type="number" value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="pos-cr-field">
              <label>Motif</label>
              <input type="text" value={moveReason} onChange={(e) => setMoveReason(e.target.value)} placeholder="Raison du mouvement" />
            </div>
            {error && <div className="pos-cr-error">{error}</div>}
            <button className="pos-cr-btn primary" onClick={handleCashMove} disabled={loading || !moveAmount}>
              Enregistrer
            </button>
            <hr />
            {staff?.role === 'manager' && (
              <button className="pos-cr-btn danger" onClick={() => setTab('close')}>
                <FiLogOut /> Clôturer la caisse
              </button>
            )}
          </div>
        )}

        {session && tab === 'close' && (
          <div className="pos-cr-tab-content">
            <p className="pos-cr-info">Saisissez les montants comptés par moyen de paiement.</p>
            {['cash', 'card', 'cheque', 'wave', 'om'].map((k) => (
              <div key={k} className="pos-cr-field">
                <label>{{ cash: 'Espèces', card: 'Carte', cheque: 'Chèque', wave: 'Wave', om: 'Orange Money' }[k]}</label>
                <input type="number" value={closingData[k]} onChange={(e) => setClosingData({ ...closingData, [k]: e.target.value })} placeholder="0" />
              </div>
            ))}
            {error && <div className="pos-cr-error">{error}</div>}
            <button className="pos-cr-btn danger" onClick={handleClose} disabled={loading}>
              {loading ? 'Clôture...' : 'Confirmer la clôture'}
            </button>
            <button className="pos-cr-btn secondary" onClick={() => setTab('operations')}>Annuler</button>
          </div>
        )}

        {tab === 'result' && result && (
          <div className="pos-cr-tab-content">
            <h4>Caisse clôturée</h4>
            <div className="pos-cr-result-grid">
              <div className="pos-cr-result-row header"><span /><span>Attendu</span><span>Compté</span><span>Écart</span></div>
              {[
                { key: 'cash', label: 'Espèces' },
                { key: 'card', label: 'Carte' },
                { key: 'cheque', label: 'Chèque' },
                { key: 'wave', label: 'Wave' },
                { key: 'om', label: 'Orange Money' },
              ].map(({ key, label }) => (
                <div key={key} className="pos-cr-result-row">
                  <span>{label}</span>
                  <span>{Math.round(result.expected?.[key] || 0).toLocaleString('fr-FR')}</span>
                  <span>{Math.round(result.counted?.[key] || 0).toLocaleString('fr-FR')}</span>
                  <span className={result.difference?.[key] === 0 ? 'ok' : 'diff'}>
                    {Math.round(result.difference?.[key] || 0).toLocaleString('fr-FR')}
                  </span>
                </div>
              ))}
            </div>
            <button className="pos-cr-btn primary" onClick={onClose}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
