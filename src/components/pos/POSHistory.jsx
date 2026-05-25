import { useEffect, useState, useCallback } from 'react';
import { FiX, FiRotateCcw, FiPrinter, FiSearch, FiChevronLeft, FiChevronRight, FiRefreshCw, FiFileText } from 'react-icons/fi';
import { posGetSalesHistory } from '../../api/pos';
import toast from 'react-hot-toast';
import './POSHistory.css';

const PAGE_SIZES = [25, 50, 100];

export default function POSHistory({ onClose, onReturn }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, pageSize };
      if (searchTerm) params.search = searchTerm;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      if (status) params.status = status;
      const res = await posGetSalesHistory(params);
      setRows(res.data?.rows || []);
      setTotal(res.data?.total || 0);
    } catch {
      toast.error('Impossible de charger l’historique');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, searchTerm, dateFrom, dateTo, status]);

  useEffect(() => { load(); }, [load]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    setSearchTerm(search.trim());
  };

  const handleResetFilters = () => {
    setSearch('');
    setSearchTerm('');
    setDateFrom('');
    setDateTo('');
    setStatus('');
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const fmtDate = (unixOrIso) => {
    if (!unixOrIso) return '—';
    const d = typeof unixOrIso === 'number'
      ? new Date(unixOrIso * 1000)
      : new Date(unixOrIso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('fr-FR');
  };

  const fmtMoney = (v) => Math.round(parseFloat(v || 0)).toLocaleString('fr-FR');

  return (
    <div className="pos-history-overlay" onClick={onClose}>
      <div className="pos-history-modal large" onClick={(e) => e.stopPropagation()}>
        <header className="pos-history-header">
          <div className="pos-history-title">
            <FiFileText size={18} />
            <div>
              <h2>Factures clients <span className="pos-history-total-chip">{total.toLocaleString('fr-FR')}</span></h2>
              <p>Historique complet des ventes du POS</p>
            </div>
          </div>
          <div className="pos-history-header-actions">
            <div className="pos-history-pagination-top">
              <select value={pageSize} onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}>
                {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input
                type="number"
                min="1"
                max={totalPages}
                value={page}
                onChange={(e) => setPage(Math.min(totalPages, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              />
              <span className="pos-history-page-sep">/ {totalPages.toLocaleString('fr-FR')}</span>
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Page précédente">
                <FiChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} aria-label="Page suivante">
                <FiChevronRight size={16} />
              </button>
            </div>
            <button type="button" className="pos-history-refresh" onClick={load} title="Actualiser">
              <FiRefreshCw size={16} />
            </button>
            <button type="button" className="pos-history-close" onClick={onClose} aria-label="Fermer">
              <FiX size={20} />
            </button>
          </div>
        </header>

        <form className="pos-history-filters" onSubmit={handleSearchSubmit}>
          <div className="pos-history-filter pos-history-filter-search">
            <FiSearch size={14} />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Réf. facture, client…"
            />
          </div>
          <div className="pos-history-filter">
            <label>Du</label>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </div>
          <div className="pos-history-filter">
            <label>Au</label>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </div>
          <div className="pos-history-filter">
            <label>État</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Tous</option>
              <option value="paid">Payée</option>
              <option value="unpaid">Impayée</option>
            </select>
          </div>
          <button type="submit" className="pos-history-filter-submit">Rechercher</button>
          {(searchTerm || dateFrom || dateTo || status) && (
            <button type="button" className="pos-history-filter-reset" onClick={handleResetFilters}>Réinitialiser</button>
          )}
        </form>

        <div className="pos-history-list">
          {loading ? (
            <div className="pos-history-empty">Chargement…</div>
          ) : rows.length === 0 ? (
            <div className="pos-history-empty">Aucune facture pour ces critères</div>
          ) : (
            <table className="pos-history-table">
              <thead>
                <tr>
                  <th>Réf.</th>
                  <th>Date facturation</th>
                  <th>Date échéance</th>
                  <th>Tiers</th>
                  <th className="num">Montant HT</th>
                  <th className="num">Montant TTC</th>
                  <th>Créé par</th>
                  <th>État</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="ref">{r.ref}</td>
                    <td>{fmtDate(r.date)}</td>
                    <td>{fmtDate(r.date_due)}</td>
                    <td>{r.customer_name || 'Client comptoir'}</td>
                    <td className="num">{fmtMoney(r.total_ht)}</td>
                    <td className="num strong">{fmtMoney(r.total_ttc)}</td>
                    <td>{r.creator_name || '—'}</td>
                    <td>
                      <span className={`pos-history-status ${r.paid == 1 ? 'paid' : 'unpaid'}`}>
                        {r.paid == 1 ? 'Payée' : 'Impayée'}
                      </span>
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="pos-history-action"
                        onClick={() => toast('Réimpression — bientôt disponible', { icon: '🚧' })}
                        title="Réimprimer le reçu"
                      >
                        <FiPrinter size={14} />
                      </button>
                      <button
                        type="button"
                        className="pos-history-action danger"
                        onClick={() => { onReturn?.(r.ref); onClose(); }}
                        title="Créer un avoir / retour"
                      >
                        <FiRotateCcw size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="pos-history-footer">
          <span>
            {total === 0 ? '0 résultat' :
              `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} sur ${total.toLocaleString('fr-FR')}`}
          </span>
        </footer>
      </div>
    </div>
  );
}
