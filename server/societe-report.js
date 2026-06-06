/**
 * État de compte client (tiers) — rapport PDF natif.
 *
 * Génère un document ODF (ODT) puis le convertit en PDF via LibreOffice
 * headless (même pile que les bons de livraison / devis). Le rapport présente
 * la synthèse des factures du tiers (total facturé, payé, impayé), la
 * répartition par statut, et deux « graphes » dessinés en barres ODF colorées :
 *   - une barre empilée payé / impayé / autres ;
 *   - l'évolution de la facturation sur 12 mois.
 *
 * Aucune dépendance externe : les barres sont des tables ODF d'1 ligne dont la
 * largeur de colonne est proportionnelle à la valeur (pas d'image à générer).
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';

const PRIMARY = '#10531a';
const MUTED = '#6b7280';
const EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || "L'Harmattan Sénégal";
const FOOTER_LEGAL = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const money = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)) + ' FCFA';

// 'YYYY-MM' → 'janv. 26'
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
}

const STATUS = {
  0: { label: 'Brouillon', color: MUTED },
  1: { label: 'Impayé', color: '#b91c1c' },
  2: { label: 'Payée', color: PRIMARY },
  3: { label: 'Abandonnée', color: '#9ca3af' },
};

const BAR_MAX_CM = 12;

// IMPORTANT : dans cette version de LibreOffice, les styles de FAMILLE TABLE
// (table / table-column / table-row / table-cell) ne sont appliqués QUE s'ils
// sont déclarés dans <office:automatic-styles> de content.xml. Placés dans
// styles.xml (office:styles), ils sont silencieusement ignorés (fond de cellule
// absent, structure perdue). Les styles de paragraphe/texte, eux, marchent
// depuis styles.xml. On regroupe donc ici tous les styles de table.
const TABLE_STYLES = `
  <style:style style:name="KpiCellT" style:family="table-cell"><style:table-cell-properties fo:background-color="#f3f4f6" fo:padding="0.25cm 0.3cm" fo:border="0.5pt solid #e5e7eb"/></style:style>
  <style:style style:name="KpiCellP" style:family="table-cell"><style:table-cell-properties fo:background-color="#ecfdf3" fo:padding="0.25cm 0.3cm" fo:border="0.5pt solid #bbf7d0"/></style:style>
  <style:style style:name="KpiCellU" style:family="table-cell"><style:table-cell-properties fo:background-color="#fef2f2" fo:padding="0.25cm 0.3cm" fo:border="0.5pt solid #fecaca"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="${PRIMARY}" fo:padding="0.15cm 0.25cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.12cm 0.25cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
  <style:style style:name="BarRow" style:family="table-row"><style:table-row-properties style:row-height="0.5cm" fo:keep-together="always"/></style:style>
  <style:style style:name="BarFillG" style:family="table-cell"><style:table-cell-properties fo:background-color="#16a34a" fo:padding="0.18cm 0"/></style:style>
  <style:style style:name="BarFillR" style:family="table-cell"><style:table-cell-properties fo:background-color="#dc2626" fo:padding="0.18cm 0"/></style:style>
  <style:style style:name="BarFillB" style:family="table-cell"><style:table-cell-properties fo:background-color="${PRIMARY}" fo:padding="0.18cm 0"/></style:style>
  <style:style style:name="BarTrack" style:family="table-cell"><style:table-cell-properties fo:background-color="#e5e7eb" fo:padding="0.18cm 0"/></style:style>
  <style:style style:name="KpiTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.15cm"/></style:style>
  <style:style style:name="KpiCol" style:family="table-column"><style:table-column-properties style:column-width="5.53cm"/></style:style>
  <style:style style:name="StatTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.15cm"/></style:style>
  <style:style style:name="ColStat" style:family="table-column"><style:table-column-properties style:column-width="4.6cm"/></style:style>
  <style:style style:name="ColNb" style:family="table-column"><style:table-column-properties style:column-width="2cm"/></style:style>
  <style:style style:name="ColAmt" style:family="table-column"><style:table-column-properties style:column-width="3.4cm"/></style:style>
  <style:style style:name="ColAmt2" style:family="table-column"><style:table-column-properties style:column-width="3.4cm"/></style:style>
  <style:style style:name="ColAmt3" style:family="table-column"><style:table-column-properties style:column-width="3.2cm"/></style:style>`;

// ─── STYLES ──────────────────────────────────────────────────
function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.12cm" fo:line-height="125%"/>
   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10.5pt" fo:color="#1a1a1a" fo:language="fr" fo:country="FR"/>
  </style:default-style>
  <style:style style:name="Editor" style:family="paragraph"><style:text-properties fo:font-size="15pt" fo:font-weight="bold" fo:color="${PRIMARY}"/></style:style>
  <style:style style:name="Tag" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.4cm" fo:border-bottom="1pt solid ${PRIMARY}" fo:padding-bottom="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${MUTED}" fo:letter-spacing="0.05cm"/></style:style>
  <style:style style:name="DocTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm" fo:margin-bottom="0.05cm"/><style:text-properties fo:font-size="19pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${PRIMARY}"/></style:style>
  <style:style style:name="DocRef" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/><style:text-properties fo:font-size="10.5pt" fo:color="${MUTED}"/></style:style>
  <style:style style:name="BlockTitle" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.55cm" fo:margin-bottom="0.15cm" fo:border-bottom="0.5pt solid #d1d5db" fo:padding-bottom="0.1cm"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${MUTED}"/></style:style>
  <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:background-color="#f0fdf4" fo:border-left="3pt solid ${PRIMARY}" fo:padding="0.3cm 0.4cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Muted" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.1cm"/><style:text-properties fo:font-size="9pt" fo:color="${MUTED}"/></style:style>
  <style:style style:name="BarLabel" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.15cm" fo:margin-bottom="0.05cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="9.5pt"/></style:style>
  <style:style style:name="Legend" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.15cm"/><style:text-properties fo:font-size="9pt" fo:color="${MUTED}"/></style:style>
  <style:style style:name="FooterLegal" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="7.5pt" fo:color="${MUTED}"/></style:style>

  <style:style style:name="LegG" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#16a34a"/></style:style>
  <style:style style:name="LegR" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#dc2626"/></style:style>
  <style:style style:name="LegGray" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="${MUTED}"/></style:style>

  <!-- Paragraphes de cellules (les styles de TABLE sont en automatic-styles de content.xml) -->
  <style:style style:name="KpiLabel" style:family="paragraph"><style:text-properties fo:font-size="8pt" fo:font-weight="bold" fo:letter-spacing="0.04cm" fo:color="${MUTED}"/></style:style>
  <style:style style:name="KpiValT" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.1cm"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold" fo:color="#374151"/></style:style>
  <style:style style:name="KpiValP" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.1cm"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold" fo:color="${PRIMARY}"/></style:style>
  <style:style style:name="KpiValU" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.1cm"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold" fo:color="#b91c1c"/></style:style>
  <style:style style:name="THeadP" style:family="paragraph"><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPR" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="TCellNum" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/></style:style>
  <style:style style:name="BarTextEmpty" style:family="paragraph"><style:text-properties fo:font-size="3pt"/></style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="1.8cm" fo:margin-bottom="1.8cm" fo:margin-left="2.2cm" fo:margin-right="2.2cm"/>
   <style:footer-style><style:header-footer-properties fo:min-height="1cm" fo:margin-top="0.4cm"/></style:footer-style>
  </style:page-layout>
 </office:automatic-styles>
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1">
   <style:footer><text:p text:style-name="FooterLegal">${escXml(FOOTER_LEGAL)}</text:p></style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;
}

// ─── CONTENU ─────────────────────────────────────────────────
function buildContent(data) {
  const { societe, totals, byStatus, monthly, generatedAt } = data;
  const auto = { n: 0, styles: [] };

  // Barre : segments = [{ value, cellStyle }]. Largeurs de colonnes ∝ valeurs ;
  // le style de table fixe sa largeur = somme exacte des colonnes (pas d'étirement).
  function bar(segments) {
    const sum = segments.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0) || 1;
    const cols = segments.map((s) => {
      const cm = Math.max(0.04, +((Math.max(0, s.value) / sum) * BAR_MAX_CM).toFixed(3));
      const name = `bc${auto.n++}`;
      auto.styles.push(`<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${cm}cm"/></style:style>`);
      return { name, cm, style: s.cellStyle };
    });
    const totalCm = cols.reduce((a, c) => a + c.cm, 0).toFixed(3);
    const tname = `bt${auto.n++}`;
    auto.styles.push(`<style:style style:name="${tname}" style:family="table"><style:table-properties style:width="${totalCm}cm" table:align="left" fo:margin-top="0.05cm" fo:margin-bottom="0.1cm"/></style:style>`);
    const colDefs = cols.map((c) => `<table:table-column table:style-name="${c.name}"/>`).join('');
    const cells = cols.map((c) => `<table:table-cell table:style-name="${c.style}"><text:p text:style-name="BarTextEmpty"></text:p></table:table-cell>`).join('');
    return `<table:table table:name="${tname}" table:style-name="${tname}">${colDefs}<table:table-row table:style-name="BarRow">${cells}</table:table-row></table:table>`;
  }

  // --- En-tête + identité tiers ---
  const addr = [societe.address, [societe.zip, societe.town].filter(Boolean).join(' ')].filter(Boolean);
  let clientBox = `<text:p text:style-name="Box"><text:span text:style-name="Bold">${escXml(societe.nom)}</text:span>`;
  if (societe.code_client) clientBox += `<text:line-break/>Code client : ${escXml(societe.code_client)}`;
  for (const a of addr) clientBox += `<text:line-break/>${escXml(a)}`;
  const contact = [societe.phone, societe.email].filter(Boolean).join(' · ');
  if (contact) clientBox += `<text:line-break/>${escXml(contact)}`;
  clientBox += `</text:p>`;

  // --- Synthèse KPI ---
  const kpi = `
  <table:table table:name="Kpi" table:style-name="KpiTable">
   <table:table-column table:style-name="KpiCol"/>
   <table:table-column table:style-name="KpiCol"/>
   <table:table-column table:style-name="KpiCol"/>
   <table:table-row>
    <table:table-cell table:style-name="KpiCellT"><text:p text:style-name="KpiLabel">TOTAL FACTURÉ</text:p><text:p text:style-name="KpiValT">${escXml(money(totals.total_ttc))}</text:p></table:table-cell>
    <table:table-cell table:style-name="KpiCellP"><text:p text:style-name="KpiLabel">TOTAL PAYÉ</text:p><text:p text:style-name="KpiValP">${escXml(money(totals.total_paid))}</text:p></table:table-cell>
    <table:table-cell table:style-name="KpiCellU"><text:p text:style-name="KpiLabel">TOTAL IMPAYÉ</text:p><text:p text:style-name="KpiValU">${escXml(money(totals.total_unpaid))}</text:p></table:table-cell>
   </table:table-row>
  </table:table>
  <text:p text:style-name="Muted">${escXml(String(totals.count))} facture(s) au total · taux de recouvrement : <text:span text:style-name="Bold">${totals.total_ttc > 0 ? Math.round((totals.total_paid / totals.total_ttc) * 100) : 0} %</text:span></text:p>`;

  // --- Graphe 1 : répartition payé / impayé / autres ---
  const paid = Math.max(0, Number(totals.total_paid) || 0);
  const unpaid = Math.max(0, Number(totals.total_unpaid) || 0);
  const other = Math.max(0, (Number(totals.total_ttc) || 0) - paid - unpaid);
  const repartBar = bar([
    { value: paid, cellStyle: 'BarFillG' },
    { value: unpaid, cellStyle: 'BarFillR' },
    { value: other, cellStyle: 'BarTrack' },
  ]);
  const repart = `
  <text:p text:style-name="BarLabel">Répartition des montants facturés</text:p>
  ${repartBar}
  <text:p text:style-name="Legend"><text:span text:style-name="LegG">&#9632;</text:span> Payé ${escXml(money(paid))}   <text:span text:style-name="LegR">&#9632;</text:span> Impayé ${escXml(money(unpaid))}   <text:span text:style-name="LegGray">&#9632;</text:span> Autres (brouillons, avoirs, abandons) ${escXml(money(other))}</text:p>`;

  // --- Tableau par statut ---
  const statusRows = Object.keys(STATUS)
    .map((k) => byStatus.find((s) => Number(s.statut) === Number(k)) || { statut: Number(k), cnt: 0, ttc: 0 })
    .filter((s) => s.cnt > 0)
    .map((s) => `
   <table:table-row>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(STATUS[s.statut]?.label || s.statut)}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellNum">${escXml(String(s.cnt))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellNum">${escXml(money(s.ttc))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellNum">${escXml(money(s.paid))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellNum">${escXml(money(s.reste))}</text:p></table:table-cell>
   </table:table-row>`).join('');
  const statusTable = `
  <table:table table:name="Stat" table:style-name="StatTable">
   <table:table-column table:style-name="ColStat"/>
   <table:table-column table:style-name="ColNb"/>
   <table:table-column table:style-name="ColAmt"/>
   <table:table-column table:style-name="ColAmt2"/>
   <table:table-column table:style-name="ColAmt3"/>
   <table:table-row>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Statut</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Nombre</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Montant TTC</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Réglé</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Reste dû</text:p></table:table-cell>
   </table:table-row>${statusRows}
  </table:table>`;

  // --- Graphe 2 : évolution facturation 12 mois ---
  const maxM = monthly.reduce((m, x) => Math.max(m, Number(x.ttc) || 0), 0);
  let monthlyBlock;
  if (!monthly.length || maxM <= 0) {
    monthlyBlock = `<text:p text:style-name="Muted">Aucune facture validée sur les 12 derniers mois.</text:p>`;
  } else {
    monthlyBlock = monthly.map((mo) => {
      const b = bar([
        { value: Number(mo.ttc) || 0, cellStyle: 'BarFillB' },
        { value: Math.max(0, maxM - (Number(mo.ttc) || 0)), cellStyle: 'BarTrack' },
      ]);
      return `<text:p text:style-name="BarLabel">${escXml(monthLabel(mo.ym))} — <text:span text:style-name="Bold">${escXml(money(mo.ttc))}</text:span>${mo.cnt ? ` (${escXml(String(mo.cnt))} fact.)` : ''}</text:p>${b}`;
    }).join('');
  }

  const dateStr = generatedAt.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

  const body = `
  <text:p text:style-name="Editor">${escXml(EDITOR_NAME)}</text:p>
  <text:p text:style-name="Tag">ÉDITION · DIFFUSION · LIBRAIRIE — Faire revenir le livre dans le quotidien des Sénégalais</text:p>

  <text:p text:style-name="DocTitle">ÉTAT DE COMPTE CLIENT</text:p>
  <text:p text:style-name="DocRef">Édité le ${escXml(dateStr)}</text:p>

  <text:p text:style-name="BlockTitle">TIERS</text:p>
  ${clientBox}

  <text:p text:style-name="BlockTitle">SYNTHÈSE</text:p>
  ${kpi}

  <text:p text:style-name="BlockTitle">RÉPARTITION DES MONTANTS</text:p>
  ${repart}

  <text:p text:style-name="BlockTitle">FACTURES PAR STATUT</text:p>
  ${statusTable}
  <text:p text:style-name="Muted">« Réglé » = paiements réellement encaissés (avoirs exclus) ; « Reste dû » = solde des factures impayées. Les colonnes se totalisent en Total payé et Total impayé de la synthèse.</text:p>

  <text:p text:style-name="BlockTitle">ÉVOLUTION DE LA FACTURATION (12 DERNIERS MOIS)</text:p>
  ${monthlyBlock}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:automatic-styles>${TABLE_STYLES}${auto.styles.join('')}</office:automatic-styles>
 <office:body><office:text>${body}</office:text></office:body>
</office:document-content>`;
}

/**
 * Construit le PDF de l'état de compte d'un tiers.
 * @param {object} data { societe, totals, byStatus, monthly, generatedAt }
 * @returns {Buffer} PDF
 */
export function buildSocieteReportPdf(data) {
  const tmpDir = join('/tmp', `tiers-report-${data.societe.id}-${Date.now()}-${process.pid}`);
  try {
    mkdirSync(join(tmpDir, 'META-INF'), { recursive: true });
    writeFileSync(join(tmpDir, 'mimetype'), 'application/vnd.oasis.opendocument.text');
    writeFileSync(join(tmpDir, 'META-INF/manifest.xml'), MANIFEST);
    writeFileSync(join(tmpDir, 'styles.xml'), buildStyles());
    writeFileSync(join(tmpDir, 'content.xml'), buildContent(data));

    const odt = join(tmpDir, 'report.odt');
    // mimetype en premier, non compressé (norme ODF), puis le reste.
    execFileSync('zip', ['-q', '-X', '-0', odt, 'mimetype'], { cwd: tmpDir });
    execFileSync('zip', ['-q', '-r', '-X', odt, 'META-INF', 'content.xml', 'styles.xml'], { cwd: tmpDir });

    const profile = join(tmpDir, 'profile');
    mkdirSync(profile, { recursive: true });
    execFileSync('soffice', [
      '--headless', '--norestore', '--nologo', '--nofirststartwizard',
      `-env:UserInstallation=file://${profile}`,
      '--convert-to', 'pdf', '--outdir', tmpDir, odt,
    ], { stdio: 'pipe', timeout: 60000 });

    const pdfPath = join(tmpDir, 'report.pdf');
    if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée (soffice)');
    return readFileSync(pdfPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
