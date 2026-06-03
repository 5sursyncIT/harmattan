// Builder de commandes ESC/POS pour imprimantes Epson (TM-T20/T88 et compatibles).
// Produit un Uint8Array prêt à être envoyé via QZ Tray (printRaw en 'hex').
// Référence : https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

// Encode un texte FR en Windows-1252 (compatible Epson CP858 avec caractères accentués).
function encodeText(text) {
  const map = {
    // Caractères accentués courants vers CP858
    'à': 0x85, 'á': 0xA0, 'â': 0x83, 'ä': 0x84, 'ã': 0xC6, 'å': 0x86,
    'è': 0x8A, 'é': 0x82, 'ê': 0x88, 'ë': 0x89,
    'ì': 0x8D, 'í': 0xA1, 'î': 0x8C, 'ï': 0x8B,
    'ò': 0x95, 'ó': 0xA2, 'ô': 0x93, 'ö': 0x94, 'õ': 0xE4,
    'ù': 0x97, 'ú': 0xA3, 'û': 0x96, 'ü': 0x81,
    'ÿ': 0x98, 'ý': 0xEC,
    'À': 0xB7, 'Á': 0xB5, 'Â': 0xB6, 'Ä': 0x8E, 'Ã': 0xC7, 'Å': 0x8F,
    'È': 0xD4, 'É': 0x90, 'Ê': 0xD2, 'Ë': 0xD3,
    'Ì': 0xDE, 'Í': 0xD6, 'Î': 0xD7, 'Ï': 0xD8,
    'Ò': 0xE3, 'Ó': 0xE0, 'Ô': 0xE2, 'Ö': 0x99, 'Õ': 0xE5,
    'Ù': 0xEB, 'Ú': 0xE9, 'Û': 0xEA, 'Ü': 0x9A,
    'Ý': 0xED,
    'ñ': 0xA4, 'Ñ': 0xA5,
    'ç': 0x87, 'Ç': 0x80,
    'œ': 0x9C, 'Œ': 0x8C,
    '€': 0xD5, '£': 0x9C, '¥': 0xBE, '§': 0xF5,
    '«': 0xAE, '»': 0xAF, '°': 0xF8,
    '–': 0x2D, '—': 0x2D, '…': 0x2E, '’': 0x27, '‘': 0x27, '“': 0x22, '”': 0x22,
  };
  const bytes = [];
  for (const ch of text) {
    const code = map[ch];
    if (code !== undefined) { bytes.push(code); continue; }
    const cp = ch.codePointAt(0);
    // ASCII pass-through
    if (cp < 0x80) { bytes.push(cp); continue; }
    bytes.push(0x3F); // '?' pour inconnu
  }
  return bytes;
}

export class Receipt {
  constructor({ width = 80 } = {}) {
    // Largeur en caractères selon papier (Epson Font A 12cpi)
    this.cols = width === 58 ? 32 : 48;
    this.buf = [];
    this.init().charset().density();
  }

  write(...bytes) { bytes.forEach((b) => this.buf.push(b)); return this; }
  text(s) { this.buf.push(...encodeText(s)); return this; }
  textLine(s) { return this.text(s).write(LF); }
  blank(n = 1) { for (let i = 0; i < n; i++) this.write(LF); return this; }

  // ─── Commandes ESC/POS de base ─────────────────────────────
  init() { return this.write(ESC, 0x40); }                 // Réinitialise
  charset() { return this.write(ESC, 0x74, 0x13); }        // CP858 (Latin 1 + €)
  // Renforce la noirceur d'impression (imprimante thermique générique 80mm pâle).
  // 1) Double-frappe : chaque ligne de points est imprimée 2× → texte plus noir.
  // 2) Paramètres de chauffe ESC 7 n1 n2 n3 : n1=points max chauffés,
  //    n2=temps de chauffe (↑ = plus foncé), n3=intervalle (↑ = plus net, moins de bavure).
  //    Défaut usine ~ (7, 80, 2) ; on monte n2 pour foncer sans bavure.
  density() {
    this.write(ESC, 0x47, 0x01);            // ESC G 1 : double-frappe ON
    this.write(ESC, 0x37, 0x0F, 0x96, 0x14); // ESC 7 : 128 dots, 1500µs chauffe, 200µs intervalle
    return this;
  }
  alignLeft() { return this.write(ESC, 0x61, 0x00); }
  alignCenter() { return this.write(ESC, 0x61, 0x01); }
  alignRight() { return this.write(ESC, 0x61, 0x02); }
  bold(on = true) { return this.write(ESC, 0x45, on ? 0x01 : 0x00); }
  underline(on = true) { return this.write(ESC, 0x2D, on ? 0x01 : 0x00); }
  // Taille de caractère : (0=normal, 0x11=double, 0x22=2x haut+large)
  size(mode = 0) { return this.write(GS, 0x21, mode); }
  feed(n = 4) { return this.write(ESC, 0x64, n); }
  cut() { return this.write(GS, 0x56, 0x42, 0x00); }        // Partial cut
  openDrawer() { return this.write(ESC, 0x70, 0x00, 0x19, 0xFA); } // Pin 2

  // Ligne horizontale (de tirets) sur toute la largeur
  hr(char = '-') { return this.textLine(char.repeat(this.cols)); }

  // Ligne en deux colonnes (libellé gauche, valeur droite alignée)
  twoCols(left, right) {
    const l = String(left);
    const r = String(right);
    const space = this.cols - l.length - r.length;
    if (space >= 1) return this.textLine(l + ' '.repeat(space) + r);
    // Si trop long, on retourne à la ligne pour la valeur
    return this.textLine(l).alignRight().textLine(r).alignLeft();
  }

  // Ligne article : label sur une ligne, puis Qté x PU = Total en dessous
  itemLine({ label, qty, unit, total }) {
    const safeLabel = (label || '').slice(0, this.cols);
    this.textLine(safeLabel);
    const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
    const unitStr = Math.round(unit).toLocaleString('fr-FR');
    const totalStr = Math.round(total).toLocaleString('fr-FR');
    const line = `  ${qtyStr} x ${unitStr}`;
    const space = this.cols - line.length - totalStr.length;
    return this.textLine(line + ' '.repeat(Math.max(1, space)) + totalStr);
  }

  build() {
    return new Uint8Array(this.buf);
  }
}

const PAYMENT_LABELS = {
  LIQ: 'Espèces', CB: 'Carte', CHQ: 'Chèque', WAVE: 'Wave', OM: 'Orange Money',
};

// Construit un ticket de caisse complet pour une vente POS
export function buildSaleReceipt(sale, { width = 80, openDrawer = false, shop = {} } = {}) {
  const r = new Receipt({ width });

  const name = shop.name || "L'HARMATTAN SENEGAL";
  const tagline = shop.tagline || 'Edition - Librairie - Diffusion';
  const address = shop.address || '10 VDN, Sicap Karak 45034, Dakar';
  const tel = shop.tel || 'Tel: +221 33 825 98 58 / +221 70 953 02 40';
  const ninea = shop.ninea || 'NINEA: 004067155';
  const rc = shop.rc || 'RC: SN DKR 2009-B-11.042';
  const website = shop.website || 'www.senharmattan.com';

  // ─── En-tête ─────────────────────────────────────────────
  r.alignCenter().bold().size(0x01).textLine(name).size(0).bold(false);
  r.textLine(tagline);
  r.textLine(address);
  r.textLine(tel);
  r.textLine(ninea);
  r.textLine(rc);
  r.alignLeft().blank();

  // ─── Métadonnées facture ─────────────────────────────────
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR');
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  r.twoCols('Facture', sale.invoice_ref || '—');
  r.twoCols('Date', `${dateStr} ${timeStr}`);
  if (sale.terminal) r.twoCols('Terminal', String(sale.terminal));
  if (sale.staff) r.twoCols('Caissier', String(sale.staff));
  if (sale.customer_name && sale.customer_name !== 'Client comptoir') {
    r.twoCols('Client', String(sale.customer_name).slice(0, r.cols - 8));
  }
  r.hr();

  // ─── Articles ────────────────────────────────────────────
  let itemCount = 0;
  (sale.items || []).forEach((item) => {
    const qty = item.qty;
    const unit = item.price_ttc || 0;
    const lineTotal = Math.round(
      item.line_total != null
        ? item.line_total
        : qty * unit * (1 - (item.discount || 0) / 100)
    );
    let label = item.label || '';
    if (item.discount > 0) label += ` (-${item.discount}%)`;
    r.itemLine({ label, qty, unit, total: lineTotal });
    itemCount += qty;
  });

  r.hr();
  r.textLine(`${itemCount} article${itemCount > 1 ? 's' : ''}`);
  r.hr('=');

  // ─── Total ───────────────────────────────────────────────
  const totalStr = `${Math.round(sale.total_ttc || 0).toLocaleString('fr-FR')} FCFA`;
  r.bold().size(0x11).twoCols('TOTAL TTC', totalStr).size(0).bold(false);
  r.hr();

  // ─── Paiements ──────────────────────────────────────────
  const totalPaid = (sale.payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
  (sale.payments || []).forEach((p) => {
    const label = PAYMENT_LABELS[p.code] || p.code;
    const amount = `${Math.round(parseFloat(p.amount)).toLocaleString('fr-FR')} F`;
    r.twoCols(label, amount);
  });
  const change = Math.round(totalPaid - (sale.total_ttc || 0));
  if (change > 0) {
    r.twoCols('Rendu monnaie', `${change.toLocaleString('fr-FR')} F`);
  }
  r.hr();

  // ─── Pied de ticket ─────────────────────────────────────
  r.alignCenter();
  r.textLine('Montants en Francs CFA BCEAO');
  r.textLine('Exoneré de TVA');
  r.blank();
  r.bold().textLine('Merci de votre visite !').bold(false);
  r.textLine(website);
  r.alignLeft();

  // ─── Code-barres de la référence facture ────────────────
  if (sale.invoice_ref) {
    r.blank().alignCenter();
    // GS h 64 : hauteur 100 dots
    r.write(GS, 0x68, 0x64);
    // GS w 3 : largeur 3
    r.write(GS, 0x77, 0x03);
    // GS H 0 : pas de texte HRI
    r.write(GS, 0x48, 0x00);
    // GS k 73 n d1..dn 0x00 : CODE128 de longueur n
    const refBytes = encodeText(sale.invoice_ref);
    r.write(GS, 0x6B, 0x49, refBytes.length, ...refBytes);
    r.alignLeft().blank();
  }

  // ─── Espacement + coupe ─────────────────────────────────
  r.feed(5);
  r.cut();

  if (openDrawer) r.openDrawer();

  return r.build();
}
