import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiRefreshCw, FiPlus, FiTrash2, FiDownload, FiX, FiSave } from 'react-icons/fi';
import { getTransferStatus, runTransfer, getEntries, createEntry, deleteEntry, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
function today() { return new Date().toISOString().split('T')[0]; }
const emptyLine = () => ({ account: '', label: '', debit: '', credit: '' });

export default function AccountingEntries() {
  const [status, setStatus] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [transferring, setTransferring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState({ date_from: yearStart(), date_to: today() });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ date: today(), ref: '', label: '', lines: [emptyLine(), emptyLine()] });

  const refresh = useCallback(() => {
    Promise.all([getTransferStatus(), getEntries({ date_from: `${new Date().getFullYear()}-01-01`, date_to: today() })])
      .then(([s, e]) => { setStatus(s.data); setEntries(e.data.entries || []); })
      .catch(() => toast.error('Erreur chargement'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleTransfer = async () => {
    setTransferring(true);
    try {
      const r = await runTransfer(period);
      toast.success(`Transfert terminé : ${r.data.inserted} lignes générées`);
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erreur transfert');
    } finally { setTransferring(false); }
  };

  const handleExportFec = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('fec', period);
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `FEC-${period.date_from}-${period.date_to}.txt`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export FEC téléchargé');
    } catch { toast.error('Erreur export FEC'); }
    finally { setExporting(false); }
  };

  // ─── Formulaire écriture OD ───
  const setLine = (i, k, v) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = (i) => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }));
  const resetForm = () => { setForm({ date: today(), ref: '', label: '', lines: [emptyLine(), emptyLine()] }); setShowForm(false); };

  const totalDebit = form.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = form.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = totalDebit === totalCredit && totalDebit > 0;

  const handleSave = async () => {
    if (!balanced) { toast.error('Écriture déséquilibrée'); return; }
    setSaving(true);
    try {
      await createEntry({
        date: form.date, ref: form.ref, label: form.label,
        lines: form.lines
          .filter(l => l.account && (Number(l.debit) || Number(l.credit)))
          .map(l => ({ account: l.account.trim(), label: l.label, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      });
      toast.success('Écriture enregistrée');
      resetForm();
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erreur enregistrement');
    } finally { setSaving(false); }
  };

  const handleDelete = async (piece) => {
    if (!window.confirm(`Supprimer l'écriture OD #${piece} ?`)) return;
    try {
      await deleteEntry(piece);
      toast.success('Écriture supprimée');
      refresh();
    } catch (e) { toast.error(e.response?.data?.error || 'Erreur suppression'); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  if (loading) return <Loader />;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0 }}>Écritures comptables</h3>
        </div>
      </div>

      {/* Transfert en comptabilité */}
      <div className="ac-action-card">
        <h4>Transfert en comptabilité</h4>
        <p style={{ fontSize: '0.83rem', color: '#64748b', margin: '0 0 12px' }}>
          Génère les écritures de partie double à partir des factures clients, factures fournisseurs et
          paiements de la période. Les écritures manuelles (OD) ne sont pas affectées.
        </p>
        <div className="ac-form-grid" style={{ marginBottom: 12 }}>
          <div className="ac-form-field">
            <label>Du</label>
            <input type="date" value={period.date_from} onChange={e => setPeriod(p => ({ ...p, date_from: e.target.value }))} />
          </div>
          <div className="ac-form-field">
            <label>Au</label>
            <input type="date" value={period.date_to} onChange={e => setPeriod(p => ({ ...p, date_to: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleTransfer} disabled={transferring}>
            <FiRefreshCw size={14} className={transferring ? 'spin' : ''} /> {transferring ? 'Transfert en cours...' : 'Lancer le transfert'}
          </button>
          <button className="btn btn-outline" onClick={handleExportFec} disabled={exporting}>
            <FiDownload size={14} /> {exporting ? 'Export...' : 'Export FEC (expert-comptable)'}
          </button>
        </div>

        {status && (
          <div className="ac-breakdown" style={{ marginTop: 14, marginBottom: 0 }}>
            <div className="ac-breakdown-item"><strong>{status.lines}</strong>Lignes au grand livre</div>
            <div className="ac-breakdown-item"><strong>{status.pieces}</strong>Pièces</div>
            <div className="ac-breakdown-item"><strong>{status.manual_lines}</strong>Lignes manuelles (OD)</div>
            {status.by_journal?.map(j => (
              <div key={j.code} className="ac-breakdown-item">
                <strong>{j.lines}</strong>{j.label} ({j.code})
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Saisie d'une écriture OD */}
      <div className="ac-section-header">
        <h4 className="ac-section-title">Journal des opérations diverses ({entries.length})</h4>
        {!showForm && <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}><FiPlus size={14} /> Nouvelle écriture</button>}
      </div>

      {showForm && (
        <div className="ac-entry-form">
          <div className="ac-form-grid" style={{ marginBottom: 12 }}>
            <div className="ac-form-field">
              <label>Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="ac-form-field">
              <label>Référence pièce</label>
              <input type="text" value={form.ref} onChange={e => setForm(f => ({ ...f, ref: e.target.value }))} placeholder="ex: OD-2026-001" />
            </div>
            <div className="ac-form-field" style={{ gridColumn: '1 / -1' }}>
              <label>Libellé de l'écriture</label>
              <input type="text" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="ex: Régularisation, dotation amortissement..." />
            </div>
          </div>

          <div className="ac-entry-head">
            <span>Compte</span><span>Libellé ligne</span><span>Débit</span><span>Crédit</span><span></span>
          </div>
          {form.lines.map((l, i) => (
            <div className="ac-entry-line" key={i}>
              <input type="text" value={l.account} onChange={e => setLine(i, 'account', e.target.value)} placeholder="N° compte" />
              <input type="text" value={l.label} onChange={e => setLine(i, 'label', e.target.value)} placeholder="Libellé" />
              <input type="number" min="0" value={l.debit} onChange={e => setLine(i, 'debit', e.target.value)} placeholder="0" />
              <input type="number" min="0" value={l.credit} onChange={e => setLine(i, 'credit', e.target.value)} placeholder="0" />
              <button className="ac-line-del" onClick={() => removeLine(i)} disabled={form.lines.length <= 2} title="Supprimer la ligne">
                <FiX size={14} />
              </button>
            </div>
          ))}
          <button className="btn btn-outline btn-sm" onClick={addLine}><FiPlus size={13} /> Ajouter une ligne</button>

          <div className={`ac-entry-balance ${balanced ? 'ok' : 'ko'}`}>
            <span>Total débit : {formatPrice(totalDebit)}</span>
            <span>Total crédit : {formatPrice(totalCredit)}</span>
            <span>{balanced ? '✓ Équilibrée' : `Écart : ${formatPrice(Math.abs(totalDebit - totalCredit))}`}</span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={!balanced || saving}>
              <FiSave size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer l\'écriture'}
            </button>
            <button className="btn btn-outline" onClick={resetForm}>Annuler</button>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: 24 }}>Aucune écriture manuelle saisie cette année.</p>
      ) : entries.map(e => (
        <div className="admin-card" key={e.piece} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div>
              <strong>Pièce #{e.piece}</strong>
              <span style={{ color: '#64748b', marginLeft: 10, fontSize: '0.85rem' }}>{fmtDate(e.date)} — {e.label || e.ref || 'OD'}</span>
            </div>
            {!e.validated && (
              <button className="ac-line-del" onClick={() => handleDelete(e.piece)} title="Supprimer">
                <FiTrash2 size={14} />
              </button>
            )}
          </div>
          <table className="ac-table">
            <tbody>
              {e.lines.map((l, i) => (
                <tr key={i}>
                  <td className="ac-ref" style={{ width: 100 }}>{l.account}</td>
                  <td>{l.account_label}</td>
                  <td style={{ color: '#64748b', fontSize: '0.82rem' }}>{l.label}</td>
                  <td className="ac-amount">{l.debit ? formatPrice(l.debit) : '—'}</td>
                  <td className="ac-amount">{l.credit ? formatPrice(l.credit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
