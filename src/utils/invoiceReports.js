// Génération de rapports factures (CSV/Excel + PDF imprimable).
// Aucune dépendance externe : CSV avec BOM UTF-8 (compatible Excel FR),
// PDF via fenêtre HTML stylée + window.print() (Save as PDF natif navigateur).

const STATUS_LABEL = { 0: 'Brouillon', 1: 'Impayée', 2: 'Payée', 3: 'Abandonnée' };
const SOURCE_LABEL = { takepos: 'POS', web: 'Web', direct: 'Direct' };

// Palette pie chart (couleurs accessibles, contrastées)
const PIE_COLORS = [
  '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#6366f1', '#f97316',
];

const fmtDateFr = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '');
const fmtNum = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

function statusLabel(inv) {
  if (inv.paid) return 'Payée';
  return STATUS_LABEL[inv.status] || '?';
}

function sourceLabel(src) {
  return SOURCE_LABEL[src] || src || 'Direct';
}

// Concatène les libellés des paiements d'une facture pour l'affichage.
function paymentSummary(payments) {
  if (!payments || payments.length === 0) return '—';
  return payments.map(p => `${p.label} (${fmtNum(p.amount)})`).join(' + ');
}

// ─── Agrégats pour les KPIs du rapport ─────────────────────────────
export function computeReportKpis(invoices) {
  const k = {
    nb: invoices.length,
    total_ttc: 0,
    total_ht: 0,
    paid_amount: 0,
    remaining: 0,
    nb_paid: 0,
    nb_unpaid: 0,
    nb_draft: 0,
    nb_credit: 0,
    by_source: {},
  };
  for (const inv of invoices) {
    const ttc = Number(inv.total_ttc) || 0;
    const ht = Number(inv.total_ht) || 0;
    const paid = Number(inv.paid_amount) || 0;
    const isCredit = inv.type === 2;
    k.total_ttc += isCredit ? -ttc : ttc;
    k.total_ht += isCredit ? -ht : ht;
    k.paid_amount += paid;
    k.remaining += Number(inv.remaining) || 0;
    if (isCredit) k.nb_credit += 1;
    else if (inv.status === 0) k.nb_draft += 1;
    else if (inv.paid || inv.status === 2) k.nb_paid += 1;
    else if (inv.status === 1) k.nb_unpaid += 1;

    const src = sourceLabel(inv.source);
    if (!k.by_source[src]) k.by_source[src] = { nb: 0, total: 0 };
    k.by_source[src].nb += 1;
    k.by_source[src].total += isCredit ? -ttc : ttc;
  }
  return k;
}

// ─── CSV (compatible Excel FR) ─────────────────────────────────────
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[";\n\r]/.test(s) ? `"${s}"` : s;
}

export function downloadInvoicesCsv({ invoices, kpis, paymentsByMethod, title, periodLabel, filename }) {
  const sep = ';';
  const lines = [];
  const totalEncaisse = (paymentsByMethod || []).reduce((s, m) => s + Number(m.total || 0), 0);

  // En-tête synthèse
  lines.push(csvEscape(title));
  lines.push(csvEscape(`Période : ${periodLabel}`));
  lines.push(csvEscape(`Généré le ${new Date().toLocaleString('fr-FR')}`));
  lines.push('');
  lines.push(['Indicateur', 'Valeur'].map(csvEscape).join(sep));
  lines.push([`Nombre de factures`, kpis.nb].map(csvEscape).join(sep));
  lines.push([`Chiffre d'affaires TTC (FCFA)`, fmtNum(kpis.total_ttc)].map(csvEscape).join(sep));
  lines.push([`Chiffre d'affaires HT (FCFA)`, fmtNum(kpis.total_ht)].map(csvEscape).join(sep));
  lines.push([`Encaissé (FCFA)`, fmtNum(kpis.paid_amount)].map(csvEscape).join(sep));
  lines.push([`Reste à encaisser (FCFA)`, fmtNum(kpis.remaining)].map(csvEscape).join(sep));
  lines.push([`Payées`, kpis.nb_paid].map(csvEscape).join(sep));
  lines.push([`Impayées`, kpis.nb_unpaid].map(csvEscape).join(sep));
  lines.push([`Brouillons`, kpis.nb_draft].map(csvEscape).join(sep));
  lines.push([`Avoirs`, kpis.nb_credit].map(csvEscape).join(sep));
  lines.push('');

  // Cumul par mode de paiement
  lines.push(['Cumul par mode de paiement'].map(csvEscape).join(sep));
  lines.push(['Mode', 'Nombre opérations', 'Total encaissé (FCFA)', 'Part (%)'].map(csvEscape).join(sep));
  for (const m of (paymentsByMethod || [])) {
    const pct = totalEncaisse > 0 ? ((m.total / totalEncaisse) * 100).toFixed(1) : '0.0';
    lines.push([m.label, m.count, fmtNum(m.total), pct.replace('.', ',')].map(csvEscape).join(sep));
  }
  if ((paymentsByMethod || []).length) {
    lines.push(['TOTAL', '', fmtNum(totalEncaisse), '100,0'].map(csvEscape).join(sep));
  }
  lines.push('');

  lines.push(['Source', 'Nombre', 'Total TTC (FCFA)'].map(csvEscape).join(sep));
  for (const [src, v] of Object.entries(kpis.by_source)) {
    lines.push([src, v.nb, fmtNum(v.total)].map(csvEscape).join(sep));
  }
  lines.push('');

  // Détail
  const headers = [
    'Référence', 'Date', 'Client', 'Source', 'Type',
    'Statut', 'Total HT', 'Total TTC', 'Encaissé', 'Reste', 'Modes de paiement',
  ];
  lines.push(headers.map(csvEscape).join(sep));
  for (const inv of invoices) {
    lines.push([
      inv.ref || `#${inv.id}`,
      fmtDateFr(inv.date),
      inv.customer_name || '',
      sourceLabel(inv.source),
      inv.type === 2 ? 'Avoir' : 'Facture',
      statusLabel(inv),
      fmtNum(inv.total_ht),
      fmtNum(inv.total_ttc),
      fmtNum(inv.paid_amount),
      fmtNum(inv.remaining),
      paymentSummary(inv.payments),
    ].map(csvEscape).join(sep));
  }

  // BOM UTF-8 pour Excel
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── PDF (HTML imprimable → Save as PDF natif) ─────────────────────
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Construit un pie chart SVG pur (pas de dépendance externe).
// data = [{ label, value, color }]
function buildSvgPie(data, { size = 220, donutRatio = 0 } = {}) {
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  if (total <= 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2 - 2}" fill="none" stroke="#e2e8f0" stroke-width="2"/><text x="${size/2}" y="${size/2}" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">Aucune donnée</text></svg>`;
  }
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  let acc = 0;
  const slices = [];

  // Cas spécial : une seule tranche = cercle complet (les arcs SVG dégénèrent à 360°).
  const nonZero = data.filter(d => d.value > 0);
  if (nonZero.length === 1) {
    const d = nonZero[0];
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${d.color}"/>
      ${donutRatio > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r * donutRatio}" fill="white"/>` : ''}
    </svg>`;
  }

  for (const d of data) {
    const value = Number(d.value) || 0;
    if (value <= 0) continue;
    const startAngle = (acc / total) * 2 * Math.PI;
    acc += value;
    const endAngle = (acc / total) * 2 * Math.PI;
    const x1 = cx + r * Math.sin(startAngle);
    const y1 = cy - r * Math.cos(startAngle);
    const x2 = cx + r * Math.sin(endAngle);
    const y2 = cy - r * Math.cos(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const pct = (value / total) * 100;
    // Position du libellé (% au centre de l'arc, à 65% du rayon)
    const midAngle = (startAngle + endAngle) / 2;
    const lx = cx + r * 0.62 * Math.sin(midAngle);
    const ly = cy - r * 0.62 * Math.cos(midAngle);
    slices.push(`<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${d.color}" stroke="white" stroke-width="2"/>`);
    if (pct >= 5) {
      slices.push(`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="11" font-weight="700">${pct.toFixed(0)}%</text>`);
    }
  }

  const hole = donutRatio > 0
    ? `<circle cx="${cx}" cy="${cy}" r="${r * donutRatio}" fill="white"/>`
    : '';

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${slices.join('')}${hole}</svg>`;
}

export function openInvoicesPdf({ invoices, kpis, paymentsByMethod, title, periodLabel }) {
  const win = window.open('', '_blank', 'width=1100,height=800');
  if (!win) {
    throw new Error('Pop-up bloqué — autorisez les pop-ups pour générer le PDF');
  }

  const rows = invoices.map(inv => `
    <tr>
      <td class="mono">${escapeHtml(inv.ref || `#${inv.id}`)}${inv.type === 2 ? ' <span class="badge-avoir">AVOIR</span>' : ''}</td>
      <td>${escapeHtml(fmtDateFr(inv.date))}</td>
      <td>${escapeHtml(inv.customer_name || '—')}</td>
      <td>${escapeHtml(sourceLabel(inv.source))}</td>
      <td class="num">${escapeHtml(fmtNum(inv.total_ttc))}</td>
      <td class="num">${escapeHtml(fmtNum(inv.paid_amount))}</td>
      <td class="num ${inv.remaining > 0 ? 'remaining' : ''}">${escapeHtml(fmtNum(inv.remaining))}</td>
      <td>${escapeHtml(paymentSummary(inv.payments))}</td>
      <td><span class="status status-${inv.paid ? 'paid' : inv.status}">${escapeHtml(statusLabel(inv))}</span></td>
    </tr>
  `).join('');

  const sourceRows = Object.entries(kpis.by_source).map(([src, v]) => `
    <tr><td>${escapeHtml(src)}</td><td class="num">${v.nb}</td><td class="num">${escapeHtml(fmtNum(v.total))} FCFA</td></tr>
  `).join('');

  // Cumul par mode de paiement + pie chart
  const pbm = (paymentsByMethod || []).map((m, i) => ({
    ...m, color: PIE_COLORS[i % PIE_COLORS.length],
  }));
  const totalEncaisse = pbm.reduce((s, m) => s + Number(m.total || 0), 0);
  const pieSvg = buildSvgPie(
    pbm.map(m => ({ label: m.label, value: m.total, color: m.color })),
    { size: 240, donutRatio: 0.55 }
  );
  const methodRows = pbm.map(m => {
    const pct = totalEncaisse > 0 ? ((m.total / totalEncaisse) * 100).toFixed(1) : '0.0';
    return `<tr>
      <td><span class="dot" style="background:${m.color}"></span>${escapeHtml(m.label)}</td>
      <td class="num">${m.count}</td>
      <td class="num">${escapeHtml(fmtNum(m.total))} FCFA</td>
      <td class="num">${pct}%</td>
    </tr>`;
  }).join('');
  const methodTotalRow = pbm.length ? `
    <tr class="total-row">
      <td><strong>TOTAL ENCAISSÉ</strong></td>
      <td class="num"><strong>${pbm.reduce((s, m) => s + m.count, 0)}</strong></td>
      <td class="num"><strong>${escapeHtml(fmtNum(totalEncaisse))} FCFA</strong></td>
      <td class="num"><strong>100%</strong></td>
    </tr>` : '';
  const pieLegend = pbm.map(m => `
    <div class="legend-item"><span class="dot" style="background:${m.color}"></span>${escapeHtml(m.label)}</div>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — ${escapeHtml(periodLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #0f172a; }
  .period { color: #64748b; font-size: 12px; margin-bottom: 4px; }
  .meta { color: #94a3b8; font-size: 10px; margin-bottom: 16px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .kpi { flex: 1 1 140px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
  .kpi .label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi .value { font-size: 14px; font-weight: 700; color: #0f172a; margin-top: 2px; }
  .kpi.success { background: #ecfdf5; border-color: #a7f3d0; }
  .kpi.warn { background: #fff7ed; border-color: #fed7aa; }
  h2 { font-size: 13px; margin: 18px 0 8px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { padding: 5px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 700; text-transform: uppercase; font-size: 9px; letter-spacing: 0.3px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mono { font-family: 'Courier New', monospace; }
  .remaining { color: #9a3412; font-weight: 600; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; }
  .status-0 { background: #f3f4f6; color: #4b5563; }
  .status-1 { background: #fff7ed; color: #9a3412; }
  .status-2, .status-paid { background: #ecfdf5; color: #166534; }
  .status-3 { background: #fee2e2; color: #991b1b; }
  .badge-avoir { background: #f3e8ff; color: #6b21a8; padding: 1px 6px; border-radius: 6px; font-size: 8px; font-weight: 700; margin-left: 4px; }
  .footer { margin-top: 18px; text-align: center; color: #94a3b8; font-size: 9px; }
  .empty { text-align: center; color: #94a3b8; padding: 24px; font-style: italic; }
  .sub-table { width: auto; min-width: 320px; }
  .total-row td { border-top: 2px solid #0f172a; background: #f1f5f9; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .payment-block { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 16px; }
  .payment-block .chart { flex: 0 0 260px; text-align: center; }
  .payment-block .chart-title { font-size: 10px; color: #64748b; text-align: center; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .payment-block .legend { margin-top: 8px; font-size: 10px; color: #475569; }
  .legend-item { display: inline-block; margin-right: 12px; }
  .payment-block .table-wrap { flex: 1 1 360px; min-width: 320px; }
  @media print {
    .no-print { display: none; }
    body { padding: 0; }
    .payment-block { page-break-inside: avoid; }
    tr { page-break-inside: avoid; }
  }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 6px; }
  .toolbar button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: white; font-weight: 600; cursor: pointer; font-size: 12px; }
  .toolbar button.secondary { background: #64748b; }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">Imprimer / Sauvegarder PDF</button>
    <button class="secondary" onclick="window.close()">Fermer</button>
  </div>

  <h1>${escapeHtml(title)}</h1>
  <div class="period">${escapeHtml(periodLabel)}</div>
  <div class="meta">Généré le ${escapeHtml(new Date().toLocaleString('fr-FR'))}</div>

  <div class="kpis">
    <div class="kpi"><div class="label">Factures</div><div class="value">${kpis.nb}</div></div>
    <div class="kpi success"><div class="label">CA TTC</div><div class="value">${escapeHtml(fmtNum(kpis.total_ttc))} FCFA</div></div>
    <div class="kpi"><div class="label">CA HT</div><div class="value">${escapeHtml(fmtNum(kpis.total_ht))} FCFA</div></div>
    <div class="kpi success"><div class="label">Encaissé</div><div class="value">${escapeHtml(fmtNum(kpis.paid_amount))} FCFA</div></div>
    <div class="kpi warn"><div class="label">Reste à encaisser</div><div class="value">${escapeHtml(fmtNum(kpis.remaining))} FCFA</div></div>
    <div class="kpi"><div class="label">Payées / Impayées</div><div class="value">${kpis.nb_paid} / ${kpis.nb_unpaid}</div></div>
    <div class="kpi"><div class="label">Brouillons / Avoirs</div><div class="value">${kpis.nb_draft} / ${kpis.nb_credit}</div></div>
  </div>

  <h2>Cumul par mode de paiement</h2>
  <div class="payment-block">
    <div class="chart">
      ${pieSvg}
      <div class="chart-title">Répartition des encaissements</div>
      <div class="legend">${pieLegend}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Mode de paiement</th><th class="num">Opérations</th><th class="num">Total encaissé</th><th class="num">Part</th></tr></thead>
        <tbody>
          ${methodRows || '<tr><td colspan="4" class="empty">Aucun encaissement sur cette période</td></tr>'}
          ${methodTotalRow}
        </tbody>
      </table>
    </div>
  </div>

  <h2>Répartition par source</h2>
  <table class="sub-table">
    <thead><tr><th>Source</th><th class="num">Nombre</th><th class="num">Total TTC</th></tr></thead>
    <tbody>${sourceRows || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody>
  </table>

  <h2>Détail des factures</h2>
  <table>
    <thead>
      <tr>
        <th>Référence</th>
        <th>Date</th>
        <th>Client</th>
        <th>Source</th>
        <th class="num">Total TTC</th>
        <th class="num">Encaissé</th>
        <th class="num">Reste</th>
        <th>Modes paiement</th>
        <th>Statut</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="9" class="empty">Aucune facture sur cette période</td></tr>'}
    </tbody>
  </table>

  <div class="footer">SenHarmattan — Rapport généré automatiquement</div>

  <script>
    // Auto-déclenche la boîte d'impression (l'utilisateur peut choisir "Sauvegarder en PDF")
    window.addEventListener('load', () => setTimeout(() => window.print(), 400));
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

// ─── Helpers de période ────────────────────────────────────────────
export function dailyRange(dateIso) {
  return { date_from: dateIso, date_to: dateIso };
}

export function monthlyRange(yearMonth) {
  // yearMonth = 'YYYY-MM'
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0); // dernier jour du mois
  const toIso = (d) => d.toISOString().split('T')[0];
  return { date_from: toIso(first), date_to: toIso(last) };
}

export function formatPeriodLabel({ kind, dateIso, yearMonth }) {
  if (kind === 'daily') {
    return `Journée du ${new Date(dateIso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return `Mois de ${d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}`;
}

export function buildFilename({ kind, dateIso, yearMonth, ext }) {
  if (kind === 'daily') return `factures-jour-${dateIso}.${ext}`;
  return `factures-mois-${yearMonth}.${ext}`;
}
