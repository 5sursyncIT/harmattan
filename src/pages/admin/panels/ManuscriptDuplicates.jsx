import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiCheck, FiCopy, FiEye, FiRotateCcw, FiTrash2 } from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';

const CONFIDENCE = {
  certain: { label: 'Certain', className: 'ms-dup-certain' },
  probable: { label: 'Probable', className: 'ms-dup-probable' },
  possible: { label: 'À vérifier', className: 'ms-dup-possible' },
};

const fmtDate = (d) => (d ? new Date(String(d).replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR') : '—');

/**
 * Arbitrage des doublons. Le serveur ne fait que RAPPROCHER : c'est ici qu'un
 * humain désigne l'original et les copies. Le marquage ne supprime rien et
 * s'annule — il sort seulement la copie des listes et des compteurs. Une fois
 * la décision prise, la copie marquée peut être supprimée définitivement.
 */
export default function ManuscriptDuplicates({ onResolved }) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  // Original retenu par groupe : par défaut le plus ancien, modifiable.
  const [chosen, setChosen] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    manuscriptsApi.duplicateGroups(showResolved ? { resolved: 1 } : {})
      .then((res) => {
        setGroups(res.data.groups || []);
        setChosen(Object.fromEntries((res.data.groups || []).map((g) => [g.key, g.original_id])));
      })
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [showResolved]);

  useEffect(() => { load(); }, [load]);

  const mark = async (group, copyId) => {
    const originalId = chosen[group.key];
    if (!originalId || originalId === copyId) return;
    const copy = group.members.find((m) => m.id === copyId);
    const original = group.members.find((m) => m.id === originalId);
    if (!window.confirm(
      `Marquer ${copy.ref} comme doublon de ${original.ref} ?\n\n`
      + `${copy.ref} disparaîtra des listes et des compteurs, sans être supprimé. `
      + 'Son historique est conservé et l\'opération est annulable.'
    )) return;
    setBusy(copyId);
    try {
      await manuscriptsApi.markDuplicate(copyId, originalId);
      toast.success(`${copy.ref} rattaché à ${original.ref}`);
      load();
      onResolved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors du marquage');
    } finally { setBusy(null); }
  };

  const unmark = async (member) => {
    setBusy(member.id);
    try {
      await manuscriptsApi.unmarkDuplicate(member.id);
      toast.success(`${member.ref} n'est plus marqué comme doublon`);
      load();
      onResolved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setBusy(null); }
  };

  // Suppression définitive d'une copie. Si elle n'est pas encore marquée, on la
  // rattache d'abord à l'original retenu (le serveur n'efface qu'un doublon
  // marqué : l'original désigné est la garantie qu'on ne perd pas l'ouvrage).
  const remove = async (group, member) => {
    const originalId = member.duplicate_of || chosen[group.key];
    if (!originalId || originalId === member.id) return;
    const original = group.members.find((x) => x.id === originalId);
    const reason = window.prompt(
      `Supprimer définitivement ${member.ref} « ${member.title} » ?\n\n`
      + `La fiche, sa frise et ses fichiers disparaissent de l'application. `
      + `L'original ${original?.ref || ''} est conservé et la suppression est tracée dans sa frise.\n\n`
      + 'Motif (facultatif) :',
      '',
    );
    if (reason === null) return;
    setBusy(member.id);
    try {
      if (!member.duplicate_of) await manuscriptsApi.markDuplicate(member.id, originalId, reason);
      await manuscriptsApi.deleteDuplicate(member.id, reason);
      toast.success(`${member.ref} supprimé`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la suppression');
    } finally {
      setBusy(null);
      load();
      onResolved?.();
    }
  };

  if (loading) return <p>Chargement des doublons...</p>;

  return (
    <div className="ms-dup-view">
      <div className="ms-dup-head">
        <p className="ms-subtitle" style={{ margin: 0 }}>
          {groups.length
            ? `${groups.length} groupe${groups.length > 1 ? 's' : ''} de manuscrits rapprochés — désignez l'original, puis rattachez-lui les copies.`
            : 'Aucun doublon détecté.'}
        </p>
        <label className="ms-dup-toggle">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Afficher les groupes déjà traités
        </label>
      </div>

      {!groups.length ? (
        <div className="ms-empty">
          <FiCheck size={22} style={{ color: '#10531a' }} />
          <div style={{ marginTop: 8 }}>
            Aucun doublon en attente d&apos;arbitrage. Les renvois évidents sont bloqués
            à la soumission ; ce qui demande un jugement humain apparaîtra ici.
          </div>
        </div>
      ) : groups.map((group) => {
        const originalId = chosen[group.key];
        const conf = CONFIDENCE[group.confidence] || CONFIDENCE.possible;
        return (
          <div key={group.key} className={`ms-dup-group ${group.resolved ? 'resolved' : ''}`}>
            <div className="ms-dup-group-head">
              <span className={`ms-dup-badge ${conf.className}`}>
                <FiAlertTriangle size={11} /> {conf.label}
              </span>
              <strong>{group.reason_label}</strong>
              {group.resolved && <span className="ms-dup-resolved-tag"><FiCheck size={11} /> traité</span>}
            </div>
            <table className="ms-table ms-dup-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Original</th>
                  <th>Réf.</th>
                  <th>Titre</th>
                  <th>Auteur</th>
                  <th>Étape</th>
                  <th>Reçu le</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {group.members.map((m) => (
                  <tr key={m.id} className={m.duplicate_of ? 'ms-dup-row-marked' : ''}>
                    <td>
                      <label className="ms-dup-radio" title="Manuscrit à conserver">
                        <input
                          type="radio"
                          name={`orig-${group.key}`}
                          checked={originalId === m.id}
                          disabled={!!m.duplicate_of}
                          onChange={() => setChosen((c) => ({ ...c, [group.key]: m.id }))}
                        />
                        <span>garder</span>
                      </label>
                    </td>
                    <td className="ms-cell-ref">{m.ref}</td>
                    <td>{m.title}</td>
                    <td className="ms-cell-muted">{m.author_name}<br /><span style={{ fontSize: '0.78rem' }}>{m.author_email}</span></td>
                    <td><span className={`ms-stage-badge ms-stage-${m.current_stage}`}>{m.stage_label}</span></td>
                    <td className="ms-cell-muted">{fmtDate(m.created_at)}</td>
                    <td>
                      <div className="ms-actions-cell">
                        <button type="button" className="ms-btn" onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>
                          <FiEye size={13} /> Ouvrir
                        </button>
                        {m.duplicate_of ? (
                          <>
                            <button type="button" className="ms-btn" disabled={busy === m.id} onClick={() => unmark(m)}>
                              <FiRotateCcw size={13} /> Annuler
                            </button>
                            <button type="button" className="ms-btn ms-btn-danger" disabled={busy === m.id} onClick={() => remove(group, m)}
                              title="Supprimer définitivement cette copie">
                              <FiTrash2 size={13} /> Supprimer
                            </button>
                          </>
                        ) : originalId !== m.id && (
                          <>
                            <button type="button" className="ms-btn ms-btn-danger" disabled={busy === m.id} onClick={() => mark(group, m.id)}>
                              <FiCopy size={13} /> Doublon
                            </button>
                            <button type="button" className="ms-btn ms-btn-danger" disabled={busy === m.id} onClick={() => remove(group, m)}
                              title="Rattacher à l'original retenu puis supprimer définitivement">
                              <FiTrash2 size={13} /> Supprimer
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
