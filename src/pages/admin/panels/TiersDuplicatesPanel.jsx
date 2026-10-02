import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiRefreshCw, FiSearch, FiGitMerge, FiXCircle, FiRotateCcw, FiExternalLink, FiMail, FiPhone, FiUser } from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  getSocieteDuplicates, dismissSocieteDuplicates, mergeSocietes, getSocieteMerges, revertSocieteMerge,
} from '../../../api/admin';
import useAdminRole from '../../../hooks/useAdminRole';
import './TiersDuplicatesPanel.css';

const MERGE_ROLES = ['super_admin', 'admin'];
const PAGE = 25;

const REASONS = {
  email: { label: 'Même email', icon: <FiMail size={12} />, strong: true },
  phone: { label: 'Même téléphone', icon: <FiPhone size={12} />, strong: true },
  name: { label: 'Même nom complet', icon: <FiUser size={12} />, strong: false },
};

const fmtMoney = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} F`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function ClusterCard({ cluster, canMerge, onDone }) {
  const [master, setMaster] = useState(cluster.suggested_master);
  const [included, setIncluded] = useState(() => new Set(cluster.members.map((m) => m.id)));
  const [busy, setBusy] = useState(false);

  const absorbed = cluster.members.filter((m) => m.id !== master && included.has(m.id));
  const masterRow = cluster.members.find((m) => m.id === master);
  const authorIds = new Set(cluster.members.filter((m) => m.id === master || included.has(m.id)).flatMap((m) => m.authors.map((a) => a.id)));

  const toggle = (id) => setIncluded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const merge = async () => {
    if (!absorbed.length) return;
    const names = absorbed.map((m) => `« ${m.nom} » (#${m.id}, ${m.invoice_count} facture${m.invoice_count > 1 ? 's' : ''})`).join('\n  • ');
    const msg = `Fusionner dans « ${masterRow.nom} » (#${master}) :\n  • ${names}\n\n`
      + 'Factures, paiements, devis, contrats et liens auteur seront rattachés à ce tiers ; '
      + 'les fiches absorbées seront archivées. L’opération est annulable depuis l’historique.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const r = await mergeSocietes(master, absorbed.map((m) => m.id));
      const failed = r.data.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${failed.length} fusion(s) en échec : ${failed.map((f) => f.error).join(' ; ')}`);
      if (r.data.merged) toast.success(`${r.data.merged} tiers fusionné(s) dans « ${masterRow.nom} »`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.results?.[0]?.error || err.response?.data?.error || 'Erreur fusion');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (!window.confirm('Ces tiers sont des personnes différentes ? Ce groupe ne sera plus proposé.')) return;
    setBusy(true);
    try {
      await dismissSocieteDuplicates(cluster.members.map((m) => m.id));
      toast.success('Groupe écarté');
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`tdup-card ${cluster.confidence === 'high' ? 'is-high' : 'is-review'}`}>
      <div className="tdup-card-head">
        <div className="tdup-reasons">
          {cluster.reasons.map((r) => (
            <span key={r} className={`tdup-reason ${REASONS[r]?.strong ? 'is-strong' : ''}`}>
              {REASONS[r]?.icon} {REASONS[r]?.label || r}
            </span>
          ))}
          {cluster.confidence === 'review' && <span className="tdup-hint">Homonymes possibles — vérifiez avant de fusionner</span>}
        </div>
        {authorIds.size > 1 && (
          <span className="tdup-warn">{authorIds.size} fiches auteur liées : possible doublon d'auteur aussi</span>
        )}
      </div>

      <div className="tdup-table-wrap">
        <table className="admin-table tdup-table">
          <thead>
            <tr>
              <th title="Fiche conservée">Garder</th>
              <th title="Inclure dans la fusion">Fusionner</th>
              <th>Nom du tiers</th>
              <th>Code client</th>
              <th>Contact</th>
              <th style={{ textAlign: 'right' }}>Factures</th>
              <th>Dernière facture</th>
              <th>Auteur lié</th>
              <th>Créé le</th>
            </tr>
          </thead>
          <tbody>
            {cluster.members.map((m) => {
              const isMaster = m.id === master;
              return (
                <tr key={m.id} className={isMaster ? 'is-master' : (!included.has(m.id) ? 'is-excluded' : '')}>
                  <td>
                    <input type="radio" name={`master-${cluster.key}`} checked={isMaster}
                      onChange={() => { setMaster(m.id); setIncluded((s) => new Set(s).add(m.id)); }}
                      aria-label={`Garder ${m.nom}`} disabled={!canMerge} />
                  </td>
                  <td>
                    {!isMaster && (
                      <input type="checkbox" checked={included.has(m.id)} onChange={() => toggle(m.id)}
                        aria-label={`Fusionner ${m.nom}`} disabled={!canMerge || m.protected} />
                    )}
                  </td>
                  <td>
                    <a href={`/admin/tiers/${m.id}`} target="_blank" rel="noreferrer" className="tdup-name">
                      {m.nom} <FiExternalLink size={11} />
                    </a>
                    {m.name_alias && <div className="tdup-sub">{m.name_alias}</div>}
                    {isMaster && <span className="tdup-master-badge">conservé</span>}
                  </td>
                  <td>{m.code_client || '—'}</td>
                  <td className="tdup-contact">
                    {m.email && <div>{m.email}</div>}
                    {m.phone && <div>{m.phone}</div>}
                    {!m.email && !m.phone && '—'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <strong>{m.invoice_count}</strong>
                    {m.invoice_count > 0 && <div className="tdup-sub">{fmtMoney(m.invoice_total)}</div>}
                  </td>
                  <td>{fmtDate(m.last_invoice)}</td>
                  <td>{m.authors.length ? m.authors.map((a) => a.name).join(', ') : '—'}</td>
                  <td>{fmtDate(m.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canMerge && (
        <div className="tdup-actions">
          <button className="btn btn-outline" onClick={dismiss} disabled={busy}>
            <FiXCircle /> Pas des doublons
          </button>
          <button className="btn btn-primary" onClick={merge} disabled={busy || !absorbed.length}>
            <FiGitMerge /> {busy ? 'Fusion…' : `Fusionner ${absorbed.length} fiche${absorbed.length > 1 ? 's' : ''} dans « ${masterRow?.nom} »`}
          </button>
        </div>
      )}
    </div>
  );
}

function MergeHistory({ canMerge }) {
  const [merges, setMerges] = useState(null);
  const load = useCallback(() => {
    getSocieteMerges().then((r) => setMerges(r.data.merges)).catch(() => toast.error('Erreur historique'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const revert = async (m) => {
    if (!window.confirm(`Annuler la fusion de « ${m.absorbed_name} » dans « ${m.master_name} » ?\nL'historique d'origine sera remis sur #${m.absorbed_id}, qui sera réactivé.`)) return;
    try {
      await revertSocieteMerge(m.id);
      toast.success('Fusion annulée');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur annulation');
    }
  };

  if (!merges) return <div className="admin-card tdup-empty">Chargement…</div>;
  if (!merges.length) return <div className="admin-card tdup-empty">Aucune fusion pour l'instant.</div>;
  return (
    <div className="admin-card" style={{ padding: 0 }}>
      <div className="tdup-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Date</th><th>Fiche absorbée</th><th>Conservée</th><th>Par</th><th>Statut</th><th /></tr>
          </thead>
          <tbody>
            {merges.map((m) => (
              <tr key={m.id}>
                <td>{fmtDate(m.created_at)}</td>
                <td>{m.absorbed_name} <span className="tdup-sub">#{m.absorbed_id}</span></td>
                <td><Link to={`/admin/tiers/${m.master_id}`}>{m.master_name}</Link> <span className="tdup-sub">#{m.master_id}</span></td>
                <td>{m.actor}</td>
                <td>{m.reverted_at ? <span className="tdup-reverted">Annulée le {fmtDate(m.reverted_at)}</span> : 'Fusionnée'}</td>
                <td style={{ textAlign: 'right' }}>
                  {canMerge && !m.reverted_at && (
                    <button className="btn btn-outline btn-sm" onClick={() => revert(m)}><FiRotateCcw /> Annuler</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function TiersDuplicatesPanel() {
  const role = useAdminRole();
  const canMerge = MERGE_ROLES.includes(role);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('high'); // high | review | history
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(() => {
    setLoading(true);
    getSocieteDuplicates()
      .then((r) => setData(r.data))
      .catch(() => toast.error('Erreur de chargement des doublons'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.clusters
      .filter((c) => c.confidence === view)
      .filter((c) => !needle || c.members.some((m) => `${m.nom} ${m.name_alias || ''} ${m.code_client || ''} ${m.email || ''} ${m.phone || ''}`.toLowerCase().includes(needle)));
  }, [data, view, q]);

  const tabs = [
    { v: 'high', l: `Même email / téléphone${data ? ` (${data.high})` : ''}`, title: 'Très probablement la même personne — vérifiez quand même (email partagé, standard…)' },
    { v: 'review', l: `Même nom${data ? ` (${data.review})` : ''}`, title: 'Même nom complet — homonymes possibles, à vérifier' },
    { v: 'history', l: 'Historique des fusions' },
  ];

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <Link to="/admin/tiers" className="tdup-back"><FiArrowLeft /> Tiers</Link>
          <h3 style={{ margin: '4px 0 0' }}>Doublons de tiers</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Choisissez la fiche à garder : factures, paiements et liens auteur y sont rattachés, les autres fiches sont archivées.
            {!canMerge && ' Fusion réservée aux administrateurs.'}
          </p>
        </div>
        <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div className="admin-search-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="tiers-segment" role="tablist" aria-label="Catégorie">
            {tabs.map((t) => (
              <button key={t.v} role="tab" aria-selected={view === t.v} title={t.title}
                className={'tiers-segment-btn ' + (view === t.v ? 'is-active' : '')}
                onClick={() => { setView(t.v); setShown(PAGE); }}>
                <span>{t.l}</span>
              </button>
            ))}
          </div>
          {view !== 'history' && (
            <div className="admin-search-input" style={{ flex: '1 1 260px', minWidth: 220 }}>
              <FiSearch />
              <input type="text" placeholder="Filtrer par nom, code, email, téléphone…" value={q}
                onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
            </div>
          )}
        </div>
      </div>

      {view === 'history' ? (
        <MergeHistory canMerge={canMerge} />
      ) : loading ? (
        <div className="admin-card tdup-empty">Analyse des tiers…</div>
      ) : !list.length ? (
        <div className="admin-card tdup-empty">Aucun doublon {view === 'high' ? 'par email / téléphone' : 'par nom'}{q ? ' pour ce filtre' : ''}.</div>
      ) : (
        <>
          {list.slice(0, shown).map((c) => (
            <ClusterCard key={c.key} cluster={c} canMerge={canMerge} onDone={load} />
          ))}
          {shown < list.length && (
            <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
              <button className="btn btn-outline" onClick={() => setShown((s) => s + PAGE)}>
                Afficher plus ({list.length - shown} restants)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
