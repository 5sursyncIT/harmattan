// Rapports de caisse (sorties d'argent) — CSV/Excel + PDF imprimable.
// Aucune dépendance externe : CSV avec BOM UTF-8 (Excel FR), PDF via fenêtre
// HTML stylée + window.print(). Calque de utils/invoiceReports.js.
//
// Le rapport rapproche les RECETTES encaissées (Dolibarr, lecture seule) et les
// DÉPENSES natives (prises dans la caisse POS) sur la période → solde net de caisse.

const fmtDateFr = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '');
const fmtNum = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

const PIE_COLORS = [
  '#9a3412', '#b45309', '#a16207', '#15803d', '#0e7490',
  '#1d4ed8', '#7c3aed', '#be185d', '#4d7c0f', '#0f766e',
];

// ─── CSV (compatible Excel FR) ─────────────────────────────────────
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[";\n\r]/.test(s) ? `"${s}"` : s;
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

export function downloadCashCsv({ report, title, periodLabel, filename }) {
  const sep = ';';
  const lines = [];
  lines.push(csvEscape(title));
  lines.push(csvEscape(`Période : ${periodLabel}`));
  lines.push(csvEscape(`Généré le ${new Date().toLocaleString('fr-FR')}`));
  lines.push('');

  // Synthèse
  lines.push(['Indicateur', 'Valeur (FCFA)'].map(csvEscape).join(sep));
  lines.push(['Recettes encaissées', fmtNum(report.receipts_total)].map(csvEscape).join(sep));
  lines.push(['Total des dépenses', fmtNum(report.expenses_total)].map(csvEscape).join(sep));
  lines.push(['Solde net (recettes − dépenses)', fmtNum(report.net)].map(csvEscape).join(sep));
  lines.push('');

  // Recettes par méthode
  lines.push(['Recettes par mode de paiement'].map(csvEscape).join(sep));
  lines.push(['Mode', 'Opérations', 'Total (FCFA)'].map(csvEscape).join(sep));
  for (const m of (report.receipts_by_method || [])) {
    lines.push([m.label, m.count, fmtNum(m.total)].map(csvEscape).join(sep));
  }
  lines.push('');

  // Dépenses par catégorie
  lines.push(['Dépenses par catégorie'].map(csvEscape).join(sep));
  lines.push(['Catégorie', 'Nombre', 'Total (FCFA)'].map(csvEscape).join(sep));
  for (const c of (report.expenses_by_category || [])) {
    lines.push([c.label, c.count, fmtNum(c.total)].map(csvEscape).join(sep));
  }
  lines.push('');

  // Détail des dépenses
  const headers = ['Référence', 'Date', 'Catégorie', 'Bénéficiaire', 'Montant (FCFA)', 'Motif', 'Saisi par', 'Origine'];
  lines.push(headers.map(csvEscape).join(sep));
  for (const e of (report.expenses || [])) {
    lines.push([
      e.ref,
      fmtDateFr(e.expense_date || e.created_at),
      e.category_label,
      e.beneficiary,
      fmtNum(e.amount),
      e.reason,
      e.created_by,
      e.in_register ? `Caisse${e.terminal ? ' T' + e.terminal : ''}` : 'Hors-caisse',
    ].map(csvEscape).join(sep));
  }

  const csv = '﻿' + lines.join('\r\n');
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
}

// ─── PDF (HTML imprimable) ─────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSvgPie(data, { size = 220 } = {}) {
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  if (total <= 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="none" stroke="#e2e8f0" stroke-width="2"/><text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">Aucune dépense</text></svg>`;
  }
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  const nonZero = data.filter(d => d.value > 0);
  if (nonZero.length === 1) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${nonZero[0].color}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="white"/></svg>`;
  }
  let acc = 0;
  const slices = [];
  for (const d of data) {
    const value = Number(d.value) || 0;
    if (value <= 0) continue;
    const startAngle = (acc / total) * 2 * Math.PI;
    acc += value;
    const endAngle = (acc / total) * 2 * Math.PI;
    const x1 = cx + r * Math.sin(startAngle), y1 = cy - r * Math.cos(startAngle);
    const x2 = cx + r * Math.sin(endAngle), y2 = cy - r * Math.cos(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const pct = (value / total) * 100;
    const midAngle = (startAngle + endAngle) / 2;
    const lx = cx + r * 0.62 * Math.sin(midAngle), ly = cy - r * 0.62 * Math.cos(midAngle);
    slices.push(`<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${d.color}" stroke="white" stroke-width="2"/>`);
    if (pct >= 5) slices.push(`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="11" font-weight="700">${pct.toFixed(0)}%</text>`);
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${slices.join('')}<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="white"/></svg>`;
}

export function openCashPdf({ report, title, periodLabel }) {
  const win = window.open('', '_blank', 'width=1100,height=800');
  if (!win) throw new Error('Pop-up bloqué — autorisez les pop-ups pour générer le PDF');

  const cats = (report.expenses_by_category || []).map((c, i) => ({ ...c, color: PIE_COLORS[i % PIE_COLORS.length] }));
  const pieSvg = buildSvgPie(cats.map(c => ({ label: c.label, value: c.total, color: c.color })), { size: 240 });
  const catRows = cats.map(c => `
    <tr><td><span class="dot" style="background:${c.color}"></span>${escapeHtml(c.label)}</td>
    <td class="num">${c.count}</td><td class="num">${escapeHtml(fmtNum(c.total))} FCFA</td></tr>`).join('');
  const catLegend = cats.map(c => `<div class="legend-item"><span class="dot" style="background:${c.color}"></span>${escapeHtml(c.label)}</div>`).join('');

  const receiptRows = (report.receipts_by_method || []).map(m => `
    <tr><td>${escapeHtml(m.label)}</td><td class="num">${m.count}</td><td class="num">${escapeHtml(fmtNum(m.total))} FCFA</td></tr>`).join('');

  const detailRows = (report.expenses || []).map(e => `
    <tr>
      <td class="mono">${escapeHtml(e.ref)}</td>
      <td>${escapeHtml(fmtDateFr(e.expense_date || e.created_at))}</td>
      <td>${escapeHtml(e.category_label)}</td>
      <td>${escapeHtml(e.beneficiary)}</td>
      <td class="num">${escapeHtml(fmtNum(e.amount))}</td>
      <td>${escapeHtml(e.reason)}</td>
    </tr>`).join('');

  const net = Number(report.net) || 0;
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${escapeHtml(title)} — ${escapeHtml(periodLabel)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .period { color: #64748b; font-size: 12px; }
  .meta { color: #94a3b8; font-size: 10px; margin-bottom: 16px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .kpi { flex: 1 1 160px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
  .kpi .label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi .value { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .kpi.in { background: #ecfdf5; border-color: #a7f3d0; }
  .kpi.out { background: #fff7ed; border-color: #fed7aa; }
  .kpi.net-pos { background: #eff6ff; border-color: #bfdbfe; }
  .kpi.net-neg { background: #fef2f2; border-color: #fecaca; }
  h2 { font-size: 13px; margin: 18px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { padding: 5px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #f1f5f9; font-weight: 700; text-transform: uppercase; font-size: 9px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mono { font-family: 'Courier New', monospace; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .block { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 16px; }
  .chart { flex: 0 0 220px; text-align: center; }
  .table-wrap { flex: 1 1 300px; min-width: 280px; }
  .legend { margin-top: 8px; font-size: 10px; color: #475569; }
  .legend-item { display: inline-block; margin-right: 12px; }
  .empty { text-align: center; color: #94a3b8; padding: 16px; font-style: italic; }
  .footer { margin-top: 18px; text-align: center; color: #94a3b8; font-size: 9px; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 6px; }
  .toolbar button { padding: 8px 14px; border: 0; border-radius: 8px; background: #10531a; color: white; font-weight: 600; cursor: pointer; }
  .toolbar button.secondary { background: #64748b; }
  @media print { .no-print { display: none; } body { padding: 0; } tr { page-break-inside: avoid; } }
</style></head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">Imprimer / Sauvegarder PDF</button>
    <button class="secondary" onclick="window.close()">Fermer</button>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <div class="period">${escapeHtml(periodLabel)}</div>
  <div class="meta">Généré le ${escapeHtml(new Date().toLocaleString('fr-FR'))}</div>

  <div class="kpis">
    <div class="kpi in"><div class="label">Recettes encaissées</div><div class="value">${escapeHtml(fmtNum(report.receipts_total))} FCFA</div></div>
    <div class="kpi out"><div class="label">Total des dépenses</div><div class="value">${escapeHtml(fmtNum(report.expenses_total))} FCFA</div></div>
    <div class="kpi ${net >= 0 ? 'net-pos' : 'net-neg'}"><div class="label">Solde net</div><div class="value">${escapeHtml(fmtNum(net))} FCFA</div></div>
  </div>

  <h2>Dépenses par catégorie</h2>
  <div class="block">
    <div class="chart">${pieSvg}<div class="legend">${catLegend}</div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Catégorie</th><th class="num">Nombre</th><th class="num">Total</th></tr></thead>
        <tbody>${catRows || '<tr><td colspan="3" class="empty">Aucune dépense sur la période</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <h2>Recettes par mode de paiement</h2>
  <table class="sub-table" style="max-width:520px">
    <thead><tr><th>Mode</th><th class="num">Opérations</th><th class="num">Total</th></tr></thead>
    <tbody>${receiptRows || '<tr><td colspan="3" class="empty">Aucune recette sur la période</td></tr>'}</tbody>
  </table>

  <h2>Détail des dépenses</h2>
  <table>
    <thead><tr><th>Référence</th><th>Date</th><th>Catégorie</th><th>Bénéficiaire</th><th class="num">Montant</th><th>Motif</th></tr></thead>
    <tbody>${detailRows || '<tr><td colspan="6" class="empty">Aucune dépense sur cette période</td></tr>'}</tbody>
  </table>

  <div class="footer">L'Harmattan Sénégal — Rapport de caisse généré automatiquement</div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 400));</script>
</body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

// ─── Helpers de période ────────────────────────────────────────────
export function dailyRange(dateIso) {
  return { date_from: dateIso, date_to: dateIso };
}

export function monthlyRange(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  if (kind === 'daily') return `caisse-jour-${dateIso}.${ext}`;
  return `caisse-mois-${yearMonth}.${ext}`;
}
