import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FiSend, FiDownload, FiImage, FiChevronDown, FiChevronUp, FiCheckCircle,
  FiBookOpen, FiTag, FiRss, FiUsers, FiBookmark, FiExternalLink, FiRefreshCw,
  FiMail, FiX, FiInstagram, FiFacebook,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import {
  listParutions, toggleParutionItem, parutionKitFicheUrl, parutionKitCoverUrl,
  getParutionNewsletterPreview, sendParutionNewsletterTest, sendParutionNewsletter, parutionSocialUrl,
} from '../../../api/parutions';
import './Contracts.css';

const STAGE_BADGE = {
  editorial_validated: { label: 'Éditorial validé', bg: '#ede9fe', color: '#5b21b6' },
  cover_design: { label: 'Couverture en conception', bg: '#fae8ff', color: '#86198f' },
  bat_author_review: { label: 'BAT chez l\'auteur', bg: '#e0f2fe', color: '#075985' },
  print_preparation: { label: 'Préparation impression', bg: '#fef3c7', color: '#92400e' },
  printing: { label: 'En impression', bg: '#dbeafe', color: '#1e40af' },
  printed: { label: 'Imprimé', bg: '#dcfce7', color: '#166534' },
  in_communication: { label: 'En communication', bg: '#cffafe', color: '#155e75' },
  published: { label: 'Paru', bg: '#dcfce7', color: '#166534' },
};

const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : null);

// Liens rapides vers les écrans existants utilisés par la checklist.
const QUICK_LINKS = [
  { to: '/admin/books', label: 'Fiche produit', icon: <FiBookOpen /> },
  { to: '/admin/slides', label: 'Bannières', icon: <FiImage /> },
  { to: '/admin/tags', label: 'Tags', icon: <FiTag /> },
  { to: '/admin/news', label: 'Actualités', icon: <FiRss /> },
  { to: '/admin/newsletter', label: 'Newsletter', icon: <FiUsers /> },
  { to: '/admin/legal-deposits', label: 'Dépôt légal', icon: <FiBookmark /> },
];

function ProgressBar({ done, total, color }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 6, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .25s' }} />
      </div>
      <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{done}/{total}</span>
    </div>
  );
}

function StatusChip({ ok, warn, label }) {
  const bg = ok ? '#dcfce7' : warn ? '#fef3c7' : '#f1f5f9';
  const color = ok ? '#166534' : warn ? '#92400e' : '#64748b';
  return (
    <span style={{ background: bg, color, borderRadius: 12, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function ChecklistSection({ title, subtitle, items, onToggle, busyKey, accent }) {
  const done = items.filter((i) => i.done).length;
  return (
    <div style={{ flex: 1, minWidth: 280 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <h4 style={{ margin: 0, fontSize: '0.92rem', color: '#1e293b' }}>{title}</h4>
        <span style={{ fontSize: '0.78rem', color: done === items.length ? '#166534' : '#64748b', fontWeight: 600 }}>
          {done}/{items.length}
        </span>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: '#94a3b8' }}>{subtitle}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item) => (
          <label
            key={item.key}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px',
              background: item.done ? '#f0fdf4' : '#fff', border: `1px solid ${item.done ? '#bbf7d0' : '#e2e8f0'}`,
              borderRadius: 8, cursor: busyKey ? 'wait' : 'pointer', transition: 'background .15s',
            }}
          >
            <input
              type="checkbox"
              checked={item.done}
              disabled={!!busyKey}
              onChange={() => onToggle(item)}
              style={{ marginTop: 3, accentColor: accent, width: 15, height: 15, flexShrink: 0 }}
            />
            <span style={{ fontSize: '0.85rem', color: item.done ? '#166534' : '#334155', lineHeight: 1.45 }}>
              {item.label}
              {item.done && item.done_by && (
                <span style={{ display: 'block', fontSize: '0.72rem', color: '#86a99a' }}>
                  {item.done_by} · {fmtDate(item.done_at) || ''}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function NewsletterModal({ m, onClose, onSent }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testEmail, setTestEmail] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getParutionNewsletterPreview(m.id)
      .then((r) => setPreview(r.data))
      .catch((err) => { toast.error(err.response?.data?.error || 'Erreur de génération de la newsletter'); onClose(); })
      .finally(() => setLoading(false));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [m.id, onClose]);

  const sendTest = async () => {
    if (!testEmail.trim()) return toast.error('Saisissez une adresse email de test');
    setBusy(true);
    try {
      await sendParutionNewsletterTest(m.id, testEmail.trim());
      toast.success(`Email de test envoyé à ${testEmail.trim()}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Échec de l\'envoi test');
    } finally { setBusy(false); }
  };

  const sendAll = async (force = false) => {
    const n = preview?.subscribers ?? 0;
    if (!window.confirm(`Envoyer la newsletter « ${preview?.subject} » à ${n} abonné(s) confirmé(s) ?${force ? '\n\n⚠️ RENVOI FORCÉ (déjà envoyée)' : ''}`)) return;
    setBusy(true);
    try {
      const r = await sendParutionNewsletter(m.id, force);
      toast.success(`Envoi lancé vers ${r.data.queued} abonné(s) — la case « newsletter » se cochera automatiquement`);
      onSent();
      onClose();
    } catch (err) {
      if (err.response?.status === 409) {
        if (window.confirm(`${err.response.data.error}\n\nForcer le renvoi ?`)) { setBusy(false); return sendAll(true); }
      } else {
        toast.error(err.response?.data?.error || 'Échec de l\'envoi');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="ct-modal-overlay" onClick={onClose}>
      <div className="ct-modal" style={{ maxWidth: 720, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiMail /> Newsletter de parution</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#64748b' }}><FiX /></button>
        </div>
        {loading ? <Loader /> : preview && (
          <>
            <p style={{ margin: '0 0 4px', fontSize: '0.85rem', color: '#334155' }}>
              <strong>Objet :</strong> {preview.subject}
            </p>
            <p style={{ margin: '0 0 10px', fontSize: '0.8rem', color: '#64748b' }}>
              {preview.subscribers} abonné(s) confirmé(s)
              {preview.last_sent && (
                <span style={{ color: '#b45309' }}> · ⚠️ déjà envoyée le {fmtDate(preview.last_sent.sent_at)} par {preview.last_sent.sent_by} ({preview.last_sent.recipients} dest.)</span>
              )}
            </p>
            <iframe
              title="Aperçu newsletter"
              srcDoc={preview.html}
              sandbox=""
              style={{ flex: 1, minHeight: 320, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="email"
                placeholder="email de test…"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                style={{ flex: 1, minWidth: 180, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.87rem' }}
              />
              <button
                onClick={sendTest}
                disabled={busy}
                style={{ background: '#fff', color: '#10531a', border: '1px solid #10531a', borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Envoyer un test
              </button>
              <button
                onClick={() => sendAll(false)}
                disabled={busy || !preview.subscribers}
                style={{ background: '#10531a', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: '0.87rem', fontWeight: 700, cursor: 'pointer' }}
              >
                Envoyer aux {preview.subscribers} abonné(s)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Télécharge un binaire authentifié (cookie) en gérant proprement les erreurs JSON.
async function downloadWithToast(url, fallbackName) {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      let msg = 'Téléchargement impossible';
      try { msg = (await resp.json()).error || msg; } catch { /* réponse non-JSON */ }
      toast.error(msg);
      return;
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const match = cd.match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] || fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    toast.error('Téléchargement impossible (réseau)');
  }
}

function ParutionCard({ m, onToggle, busyKey, onOpenNewsletter }) {
  const [open, setOpen] = useState(['printed', 'in_communication'].includes(m.current_stage));
  const badge = STAGE_BADGE[m.current_stage] || { label: m.stage_label, bg: '#f1f5f9', color: '#334155' };
  const isBriefStage = m.section === 'brief';
  const brief = m.checklist.filter((i) => i.phase === 'brief');
  const teasing = m.checklist.filter((i) => i.phase === 'teasing');
  const lancement = m.checklist.filter((i) => i.phase === 'lancement');
  const allDone = isBriefStage
    ? m.brief_done === m.brief_total
    : m.brief_done + m.teasing_done + m.launch_done === m.brief_total + m.teasing_total + m.launch_total;

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
      {/* En-tête cliquable */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '14px 18px',
          background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.98rem', color: '#0f172a' }}>{m.title}</strong>
            {allDone && <FiCheckCircle style={{ color: '#16a34a', flexShrink: 0 }} title="Checklist complète" />}
            <span style={{ background: badge.bg, color: badge.color, borderRadius: 12, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>
              {badge.label}
            </span>
          </div>
          <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 3 }}>
            {m.author_name} · {m.ref}{m.isbn ? ` · ISBN ${m.isbn}` : ''}{m.print_qty ? ` · ${m.print_qty} ex.` : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {isBriefStage ? (
              <>
                {/* Matière première du brief : ce qui manque pour préparer la campagne */}
                <StatusChip ok={m.has_synopsis} warn={!m.has_synopsis} label={m.has_synopsis ? 'Synopsis disponible' : 'Synopsis manquant'} />
                <StatusChip ok={m.author_has_bio} warn={!m.author_has_bio} label={m.author_has_bio ? 'Bio auteur disponible' : 'Bio auteur manquante'} />
                <StatusChip ok={m.author_has_photo} warn={!m.author_has_photo} label={m.author_has_photo ? 'Photo auteur disponible' : 'Photo auteur manquante'} />
              </>
            ) : (
              <>
                <StatusChip ok={!!m.dolibarr_product_id} warn={!m.dolibarr_product_id} label={m.dolibarr_product_id ? 'Produit lié' : 'Produit non lié'} />
                <StatusChip
                  ok={!!m.upcoming}
                  warn={!m.upcoming && !['printed', 'in_communication', 'published'].includes(m.current_stage)}
                  label={m.upcoming ? `À paraître${m.upcoming.release_date ? ` · ${fmtDate(m.upcoming.release_date)}` : ''}` : 'À paraître non activé'}
                />
                <StatusChip
                  ok={m.legal_deposit_status === 'deposited'}
                  warn={['printed', 'in_communication', 'published'].includes(m.current_stage) && m.legal_deposit_status !== 'deposited'}
                  label={m.legal_deposit_status === 'deposited' ? 'Dépôt légal fait' : m.legal_deposit_status === 'todo' ? 'Dépôt légal à faire' : 'Dépôt légal non enregistré'}
                />
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <ProgressBar done={m.brief_done} total={m.brief_total} color="#7c3aed" />
          {!isBriefStage && <ProgressBar done={m.teasing_done} total={m.teasing_total} color="#d97706" />}
          {!isBriefStage && <ProgressBar done={m.launch_done} total={m.launch_total} color="#16a34a" />}
        </div>
        {open ? <FiChevronUp style={{ color: '#94a3b8', flexShrink: 0 }} /> : <FiChevronDown style={{ color: '#94a3b8', flexShrink: 0 }} />}
      </button>

      {open && (
        <div style={{ borderTop: '1px solid #f1f5f9', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Kit de lancement + liens rapides */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <a
              href={parutionKitFicheUrl(m.id)}
              download
              className="ct-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#10531a', color: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}
            >
              <FiDownload /> Kit de lancement (fiche)
            </a>
            {m.has_cover ? (
              <a
                href={parutionKitCoverUrl(m.id)}
                download
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', color: '#10531a', border: '1px solid #10531a', borderRadius: 8, padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}
              >
                <FiImage /> Couverture (BAT)
              </a>
            ) : (
              <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Aucune couverture déposée</span>
            )}
            {(m.has_cover || m.dolibarr_product_id) && (
              <>
                {/* Pack réseaux : visuels générés à la volée depuis la couverture */}
                <button
                  onClick={() => downloadWithToast(parutionSocialUrl(m.id, 'square'), 'visuel-1080.png')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', color: '#7c3aed', border: '1px solid #7c3aed', borderRadius: 8, padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  <FiInstagram /> Visuel 1080×1080
                </button>
                <button
                  onClick={() => downloadWithToast(parutionSocialUrl(m.id, 'og'), 'visuel-1200x628.png')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', color: '#7c3aed', border: '1px solid #7c3aed', borderRadius: 8, padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  <FiFacebook /> Visuel 1200×628
                </button>
              </>
            )}
            {!isBriefStage && m.dolibarr_product_id && (
              <button
                onClick={() => onOpenNewsletter(m)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: m.newsletter_sent_at ? '#f0fdf4' : '#fff', color: '#0369a1', border: '1px solid #0369a1', borderRadius: 8, padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}
              >
                <FiMail /> {m.newsletter_sent_at ? `Newsletter envoyée ✓` : 'Newsletter parution'}
              </button>
            )}
            <span style={{ flex: 1 }} />
            {QUICK_LINKS.map((l) => (
              <Link key={l.to} to={l.to} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.78rem', color: '#0369a1', textDecoration: 'none' }}>
                {l.icon} {l.label} <FiExternalLink size={11} />
              </Link>
            ))}
          </div>

          {/* Checklists */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <ChecklistSection
              title="Brief de campagne"
              subtitle="Dès la validation éditoriale — préparation interne pendant la conception de la couverture."
              items={brief}
              onToggle={(item) => onToggle(m, item)}
              busyKey={busyKey}
              accent="#7c3aed"
            />
            {!isBriefStage && (
              <ChecklistSection
                title="Teasing & précommande"
                subtitle="Dès le BAT validé — lancer la machine commerciale avant l'impression."
                items={teasing}
                onToggle={(item) => onToggle(m, item)}
                busyKey={busyKey}
                accent="#d97706"
              />
            )}
            {!isBriefStage && (
              <ChecklistSection
                title="Lancement officiel"
                subtitle="À l'impression terminée — basculer de « à paraître » à « disponible »."
                items={lancement}
                onToggle={(item) => onToggle(m, item)}
                busyKey={busyKey}
                accent="#16a34a"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ParutionsPanel() {
  const [manuscripts, setManuscripts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [newsletterFor, setNewsletterFor] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    listParutions()
      .then((r) => setManuscripts(r.data.manuscripts || []))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement des parutions'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onToggle = async (m, item) => {
    const key = `${m.id}:${item.key}`;
    setBusyKey(key);
    try {
      const r = await toggleParutionItem(m.id, item.key, !item.done);
      setManuscripts((prev) => prev.map((x) => {
        if (x.id !== m.id) return x;
        const checklist = x.checklist.map((i) => (i.key === item.key ? { ...i, done: !item.done, done_by: 'vous', done_at: null } : i));
        return {
          ...x,
          checklist,
          brief_done: checklist.filter((i) => i.phase === 'brief' && i.done).length,
          teasing_done: checklist.filter((i) => i.phase === 'teasing' && i.done).length,
          launch_done: checklist.filter((i) => i.phase === 'lancement' && i.done).length,
        };
      }));
      if (r.data.brief_ready) {
        toast.success(`« ${m.title} » — brief de campagne complet, la communication peut préparer le lancement`);
      }
      if (r.data.launch_prepared) {
        toast.success(`« ${m.title} » — lancement commercial préparé 🎉`);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la mise à jour');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <FiSend /> Parutions
        </h2>
        <button
          onClick={load}
          disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, padding: '7px 12px', fontSize: '0.83rem', cursor: 'pointer', color: '#334155' }}
        >
          <FiRefreshCw /> Actualiser
        </button>
      </div>
      <p style={{ color: '#64748b', fontSize: '0.88rem', margin: '0 0 18px' }}>
        Relais commercial des ouvrages en fin de pipeline : brief de campagne (dès la validation
        éditoriale), teasing (dès le BAT validé) puis lancement officiel (à l'impression terminée),
        avec kit de lancement téléchargeable.
      </p>

      {loading ? (
        <Loader />
      ) : manuscripts.length === 0 ? (
        <div style={{ border: '2px dashed #e2e8f0', borderRadius: 12, padding: '48px 20px', textAlign: 'center', color: '#94a3b8' }}>
          Aucun ouvrage entre la validation éditoriale et l'impression.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {['parution', 'brief'].map((section) => {
            const items = manuscripts.filter((m) => m.section === section);
            if (!items.length) return null;
            return (
              <div key={section}>
                <h3 style={{ margin: '0 0 10px', fontSize: '0.95rem', color: '#334155' }}>
                  {section === 'parution'
                    ? 'Parutions — teasing & lancement (BAT validé → imprimé)'
                    : 'Briefs de campagne — en amont (couverture en cours)'}
                  <span style={{ marginLeft: 8, color: '#94a3b8', fontWeight: 400 }}>({items.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {items.map((m) => (
                    <ParutionCard key={m.id} m={m} onToggle={onToggle} busyKey={busyKey} onOpenNewsletter={setNewsletterFor} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {newsletterFor && (
        <NewsletterModal m={newsletterFor} onClose={() => setNewsletterFor(null)} onSent={load} />
      )}
    </div>
  );
}
