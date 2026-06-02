/**
 * Accounting Engine — Transfert en comptabilité (génération des écritures).
 *
 * Convertit les documents opérationnels Dolibarr (factures clients, factures
 * fournisseurs, paiements) en écritures de partie double dans le grand livre
 * natif `llx_accounting_bookkeeping` (plan SYSCOHADA).
 *
 * Les écritures générées portent import_key = 'AUTOGEN' : elles sont supprimées
 * puis régénérées à chaque transfert. Les écritures manuelles (journal OD,
 * import_key NULL) ne sont jamais touchées.
 */

const ENTITY = 1;

// ─── PLAN DE COMPTES SYSCOHADA (comptes par défaut) ──────────
export const SYSCOHADA = {
  customer: '411',        // Clients
  supplier: '401',        // Fournisseurs, dettes en comptes
  vat_collected: '4431',  // T.V.A. facturée sur ventes
  vat_deductible: '4452', // T.V.A. récupérable sur achats
  sales: '701',           // Ventes de marchandises
  purchases: '601',       // Achats de marchandises
  suspense: '471',        // Compte d'attente
  cash: '571',            // Caisse
  bank: '521',            // Banques locales
};

// ─── HELPERS ─────────────────────────────────────────────────

function isCashAccount(label, ref) {
  const s = `${label || ''} ${ref || ''}`.toLowerCase();
  return /liquid|caisse|cash|espece|espèce/.test(s);
}

/** Compte comptable général d'un compte bancaire selon le paramétrage Dolibarr. */
function normalizeAccount(num) {
  const s = String(num ?? '').trim();
  return s && s !== '0' ? s : null;
}

// Constantes Dolibarr (llx_const) → clés internes du plan de comptes.
const CONST_TO_ACCOUNT = {
  ACCOUNTING_ACCOUNT_CUSTOMER: 'customer',
  ACCOUNTING_ACCOUNT_SUPPLIER: 'supplier',
  ACCOUNTING_VAT_SOLD_ACCOUNT: 'vat_collected',
  ACCOUNTING_VAT_BUY_ACCOUNT: 'vat_deductible',
  ACCOUNTING_PRODUCT_SOLD_ACCOUNT: 'sales',
  ACCOUNTING_PRODUCT_BUY_ACCOUNT: 'purchases',
  ACCOUNTING_ACCOUNT_SUSPENSE: 'suspense',
};

/**
 * Comptes par défaut : on part du plan SYSCOHADA puis on écrase avec les
 * constantes ACCOUNTING_* réellement paramétrées dans Dolibarr (llx_const),
 * pour rester aligné sur la configuration de l'ERP. Repli garanti sur SYSCOHADA.
 */
async function loadDefaultAccounts(pool) {
  const acc = { ...SYSCOHADA };
  const names = Object.keys(CONST_TO_ACCOUNT);
  const [rows] = await pool.query(
    `SELECT name, value FROM llx_const WHERE entity IN (0, ?) AND name IN (${names.map(() => '?').join(',')})`,
    [ENTITY, ...names]
  );
  for (const r of rows) {
    const key = CONST_TO_ACCOUNT[r.name];
    const val = normalizeAccount(r.value);
    if (key && val) acc[key] = val;
  }
  return acc;
}

/** Charge la table des libellés de comptes (numero → label). */
async function loadAccountLabels(pool) {
  const [rows] = await pool.query(
    `SELECT account_number, label FROM llx_accounting_account WHERE entity = ? AND active = 1`,
    [ENTITY]
  );
  const map = new Map();
  for (const r of rows) map.set(String(r.account_number), r.label);
  return map;
}

// Libellés français des journaux (la table Dolibarr ne stocke que des clés de traduction).
const JOURNAL_LABELS = {
  VT: 'Journal des ventes',
  AC: 'Journal des achats',
  BQ: 'Journal de banque',
  OD: 'Opérations diverses',
};

/**
 * Map fk_account (rowid llx_bank_account) → compte comptable.
 * Source de vérité : llx_bank_account.account_number (compte du grand livre
 * paramétré dans Dolibarr). À défaut seulement, on retombe sur l'heuristique
 * caisse/banque et on signale le compte non paramétré (warning).
 * @returns {Promise<{map: Map<number,string>, unconfigured: Array<{id:number, ref:string, label:string, fallback:string}>}>}
 */
async function loadBankAccountMap(pool, acc = SYSCOHADA) {
  const [rows] = await pool.query(
    `SELECT rowid, ref, label, account_number FROM llx_bank_account WHERE entity = ?`,
    [ENTITY]
  );
  const map = new Map();
  const unconfigured = [];
  for (const r of rows) {
    const configured = normalizeAccount(r.account_number);
    if (configured) {
      map.set(Number(r.rowid), configured);
    } else {
      const fallback = isCashAccount(r.label, r.ref) ? acc.cash : acc.bank;
      map.set(Number(r.rowid), fallback);
      unconfigured.push({ id: Number(r.rowid), ref: r.ref, label: r.label, fallback });
    }
  }
  return { map, unconfigured };
}

function fmtDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().split('T')[0];
}

// ─── TRANSFERT EN COMPTABILITÉ ───────────────────────────────

/**
 * Génère les écritures comptables pour une période.
 * @returns {Promise<{deleted:number, inserted:number, pieces:number, breakdown:object}>}
 */
export async function runTransfer(pool, { date_from, date_to, userId = 0, force = false }) {
  const conn = await pool.getConnection();
  try {
    return await runTransferTx(conn, { date_from, date_to, userId, force });
  } finally {
    conn.release();
  }
}

/**
 * Garde anti-conflit avec le transfert natif Dolibarr.
 *
 * Le moteur AUTOGEN n'écrit PAS `fk_code_ventilation` sur les lignes de facture :
 * le journal natif (sellsjournal.php) continue donc de voir ces factures comme
 * « non transférées » et un opérateur pourrait relancer le transfert natif, créant
 * des doublons que l'anti-doublon natif (basé sur le label) ne détecte pas.
 * On refuse donc de régénérer si la période contient déjà des traces du flux natif
 * (lignes ventilées, ou écritures VT/AC/BQ non-AUTOGEN dans le grand livre).
 */
async function assertNoNativeConflict(conn, date_from, date_to) {
  const [[vent]] = await conn.query(
    `SELECT COUNT(*) AS n
       FROM llx_facturedet fd
       JOIN llx_facture f ON f.rowid = fd.fk_facture
      WHERE f.entity = ? AND f.datef BETWEEN ? AND ? AND fd.fk_code_ventilation > 0`,
    [ENTITY, date_from, date_to]
  );
  const [[book]] = await conn.query(
    `SELECT COUNT(*) AS n
       FROM llx_accounting_bookkeeping
      WHERE entity = ? AND doc_date BETWEEN ? AND ?
        AND (import_key IS NULL OR import_key <> 'AUTOGEN')
        AND code_journal IN ('VT', 'AC', 'BQ')`,
    [ENTITY, date_from, date_to]
  );
  if (Number(vent.n) > 0 || Number(book.n) > 0) {
    const err = new Error(
      `Conflit avec le transfert natif Dolibarr sur ${date_from} → ${date_to} : ` +
      `${vent.n} ligne(s) de facture déjà ventilée(s) et ${book.n} écriture(s) VT/AC/BQ ` +
      `non générée(s) par ce module. Régénérer écraserait/dupliquerait des écritures officielles. ` +
      `Relancez avec force=true seulement si vous savez ce que vous faites.`
    );
    err.code = 'NATIVE_CONFLICT';
    throw err;
  }
}

/**
 * Immuabilité comptable : refuse de régénérer une période qui contient au moins
 * une écriture figée (date_validated NOT NULL). Une clôture rend les écritures
 * inaltérables ; régénérer reviendrait à dupliquer (la purge ne touche plus les
 * lignes validées). Ce garde-fou n'est PAS contournable par force.
 */
async function assertNoValidatedEntries(conn, date_from, date_to) {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS n FROM llx_accounting_bookkeeping
      WHERE entity = ? AND doc_date BETWEEN ? AND ? AND date_validated IS NOT NULL`,
    [ENTITY, date_from, date_to]
  );
  if (Number(r.n) > 0) {
    const err = new Error(
      `Période ${date_from} → ${date_to} verrouillée : ${r.n} écriture(s) déjà validée(s)/clôturée(s). ` +
      `Le transfert ne peut pas régénérer une période close (immuabilité comptable).`
    );
    err.code = 'LOCKED_PERIOD';
    throw err;
  }
}

async function runTransferTx(conn, { date_from, date_to, userId, force }) {
  const acc = await loadDefaultAccounts(conn);
  const accLabels = await loadAccountLabels(conn);
  const journals = JOURNAL_LABELS;
  const { map: bankMap, unconfigured } = await loadBankAccountMap(conn, acc);
  const warnings = [];
  if (unconfigured.length) {
    warnings.push(
      `${unconfigured.length} compte(s) bancaire(s) sans compte comptable paramétré ` +
      `(account_number) — repli heuristique appliqué : ` +
      unconfigured.map(u => `${u.ref || '#' + u.id}→${u.fallback}`).join(', ')
    );
  }
  let suspenseHits = 0;

  const labelOf = (num) => accLabels.get(String(num)) || num;

  if (!force) await assertNoNativeConflict(conn, date_from, date_to);
  // Immuabilité : on ne régénère jamais une période contenant des écritures validées
  // (figées par une clôture). Le 'force' ne lève PAS ce garde-fou.
  await assertNoValidatedEntries(conn, date_from, date_to);

  await conn.beginTransaction();
  try {

  // 1. Purge des écritures auto précédentes sur la période (les manuelles ET les
  //    écritures validées/figées restent — date_validated IS NULL uniquement).
  const [del] = await conn.query(
    `DELETE FROM llx_accounting_bookkeeping
     WHERE entity = ? AND import_key = 'AUTOGEN' AND date_validated IS NULL
       AND doc_date BETWEEN ? AND ?`,
    [ENTITY, date_from, date_to]
  );

  // 2. Numéro de pièce de départ
  const [[mx]] = await conn.query(
    `SELECT COALESCE(MAX(piece_num), 0) AS m FROM llx_accounting_bookkeeping WHERE entity = ? FOR UPDATE`,
    [ENTITY]
  );
  let pieceNum = Number(mx.m);

  const rows = [];
  const breakdown = { sales: 0, sales_payments: 0, purchases: 0, purchase_payments: 0 };

  // Ajoute une ligne d'écriture (gère le signe : montant négatif inverse débit/crédit).
  function leg({ piece, date, docType, docRef, fkDoc, journal, account, signed, naturalSide, thirdCode, thirdLabel, opLabel }) {
    const side = signed >= 0 ? naturalSide : (naturalSide === 'D' ? 'C' : 'D');
    const amount = Math.abs(Math.round(signed * 100) / 100);
    if (amount === 0) return;
    rows.push([
      ENTITY, piece, date, docType, docRef || '', fkDoc || 0, 0,
      thirdCode || '', thirdCode || '', thirdLabel || '',
      String(account), labelOf(account), opLabel || '',
      side === 'D' ? amount : 0, side === 'C' ? amount : 0, amount, side,
      userId, new Date(), journal, journals[journal] || journal, 'AUTOGEN',
    ]);
  }

  // 3. Factures clients (journal VT) — comptabilité d'engagement
  const [invoices] = await conn.query(
    `SELECT f.rowid, f.ref, f.datef, f.type, f.total_ht, f.total_tva, f.total_ttc,
            s.rowid AS soc_id, s.nom AS soc_name, s.code_client
     FROM llx_facture f
     LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
     WHERE f.entity = ? AND f.fk_statut IN (1, 2) AND f.datef BETWEEN ? AND ?`,
    [ENTITY, date_from, date_to]
  );
  for (const inv of invoices) {
    pieceNum += 1;
    const date = fmtDate(inv.datef);
    const thirdCode = inv.code_client || (inv.soc_id ? `CL${inv.soc_id}` : '');
    const isCredit = Number(inv.type) === 2;
    const opLabel = `${isCredit ? 'Avoir' : 'Facture'} ${inv.ref}${inv.soc_name ? ' — ' + inv.soc_name : ''}`;
    const common = { piece: pieceNum, date, docType: 'customer_invoice', docRef: inv.ref, fkDoc: inv.rowid, journal: 'VT', opLabel };
    // Client (411) au débit du TTC
    leg({ ...common, account: acc.customer, signed: Number(inv.total_ttc), naturalSide: 'D', thirdCode, thirdLabel: inv.soc_name });
    // Ventes (701) au crédit du HT
    leg({ ...common, account: acc.sales, signed: Number(inv.total_ht), naturalSide: 'C' });
    // TVA collectée (4431) au crédit
    if (Number(inv.total_tva) !== 0) {
      leg({ ...common, account: acc.vat_collected, signed: Number(inv.total_tva), naturalSide: 'C' });
    }
    breakdown.sales += 1;
  }

  // 4. Paiements clients (journal BQ)
  const [payments] = await conn.query(
    `SELECT p.rowid, p.ref, p.datep, p.amount, p.fk_bank,
            bk.fk_account,
            (SELECT s.nom FROM llx_paiement_facture pf
               JOIN llx_facture f ON f.rowid = pf.fk_facture
               JOIN llx_societe s ON s.rowid = f.fk_soc
             WHERE pf.fk_paiement = p.rowid LIMIT 1) AS soc_name,
            (SELECT s.code_client FROM llx_paiement_facture pf
               JOIN llx_facture f ON f.rowid = pf.fk_facture
               JOIN llx_societe s ON s.rowid = f.fk_soc
             WHERE pf.fk_paiement = p.rowid LIMIT 1) AS code_client,
            (SELECT f.fk_soc FROM llx_paiement_facture pf
               JOIN llx_facture f ON f.rowid = pf.fk_facture
             WHERE pf.fk_paiement = p.rowid LIMIT 1) AS soc_id
     FROM llx_paiement p
     LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
     WHERE p.entity = ? AND p.datep BETWEEN ? AND ?`,
    [ENTITY, date_from, date_to]
  );
  for (const pay of payments) {
    pieceNum += 1;
    const date = fmtDate(pay.datep);
    let bankAcc = bankMap.get(Number(pay.fk_account));
    if (!bankAcc) { bankAcc = acc.suspense; suspenseHits += 1; }
    const thirdCode = pay.code_client || (pay.soc_id ? `CL${pay.soc_id}` : '');
    const opLabel = `Encaissement ${pay.ref || '#' + pay.rowid}${pay.soc_name ? ' — ' + pay.soc_name : ''}`;
    const common = { piece: pieceNum, date, docType: 'bank', docRef: pay.ref, fkDoc: pay.rowid, journal: 'BQ', opLabel };
    // Trésorerie au débit
    leg({ ...common, account: bankAcc, signed: Number(pay.amount), naturalSide: 'D' });
    // Client au crédit
    leg({ ...common, account: acc.customer, signed: Number(pay.amount), naturalSide: 'C', thirdCode, thirdLabel: pay.soc_name });
    breakdown.sales_payments += 1;
  }

  // 5. Factures fournisseurs (journal AC)
  const [supplierInvoices] = await conn.query(
    `SELECT f.rowid, f.ref, f.ref_supplier, f.datef, f.total_ht, f.total_tva, f.total_ttc,
            s.rowid AS soc_id, s.nom AS soc_name, s.code_fournisseur
     FROM llx_facture_fourn f
     LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
     WHERE f.entity = ? AND f.fk_statut IN (1, 2) AND f.datef BETWEEN ? AND ?`,
    [ENTITY, date_from, date_to]
  );
  for (const inv of supplierInvoices) {
    pieceNum += 1;
    const date = fmtDate(inv.datef);
    const thirdCode = inv.code_fournisseur || (inv.soc_id ? `FO${inv.soc_id}` : '');
    const opLabel = `Facture fourn. ${inv.ref_supplier || inv.ref}${inv.soc_name ? ' — ' + inv.soc_name : ''}`;
    const common = { piece: pieceNum, date, docType: 'supplier_invoice', docRef: inv.ref, fkDoc: inv.rowid, journal: 'AC', opLabel };
    leg({ ...common, account: acc.purchases, signed: Number(inv.total_ht), naturalSide: 'D' });
    if (Number(inv.total_tva) !== 0) {
      leg({ ...common, account: acc.vat_deductible, signed: Number(inv.total_tva), naturalSide: 'D' });
    }
    leg({ ...common, account: acc.supplier, signed: Number(inv.total_ttc), naturalSide: 'C', thirdCode, thirdLabel: inv.soc_name });
    breakdown.purchases += 1;
  }

  // 6. Paiements fournisseurs (journal BQ) — table optionnelle
  try {
    const [supplierPayments] = await conn.query(
      `SELECT p.rowid, p.ref, p.datep, p.amount, bk.fk_account,
              (SELECT s.nom FROM llx_paiementfourn_facturefourn pf
                 JOIN llx_facture_fourn f ON f.rowid = pf.fk_facturefourn
                 JOIN llx_societe s ON s.rowid = f.fk_soc
               WHERE pf.fk_paiementfourn = p.rowid LIMIT 1) AS soc_name,
              (SELECT s.code_fournisseur FROM llx_paiementfourn_facturefourn pf
                 JOIN llx_facture_fourn f ON f.rowid = pf.fk_facturefourn
                 JOIN llx_societe s ON s.rowid = f.fk_soc
               WHERE pf.fk_paiementfourn = p.rowid LIMIT 1) AS code_fournisseur
       FROM llx_paiementfourn p
       LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
       WHERE p.entity = ? AND p.datep BETWEEN ? AND ?`,
      [ENTITY, date_from, date_to]
    );
    for (const pay of supplierPayments) {
      pieceNum += 1;
      const date = fmtDate(pay.datep);
      let bankAcc = bankMap.get(Number(pay.fk_account));
      if (!bankAcc) { bankAcc = acc.suspense; suspenseHits += 1; }
      const thirdCode = pay.code_fournisseur || '';
      const opLabel = `Règlement fourn. ${pay.ref || '#' + pay.rowid}${pay.soc_name ? ' — ' + pay.soc_name : ''}`;
      const common = { piece: pieceNum, date, docType: 'bank', docRef: pay.ref, fkDoc: pay.rowid, journal: 'BQ', opLabel };
      leg({ ...common, account: acc.supplier, signed: Number(pay.amount), naturalSide: 'D', thirdCode, thirdLabel: pay.soc_name });
      leg({ ...common, account: bankAcc, signed: Number(pay.amount), naturalSide: 'C' });
      breakdown.purchase_payments += 1;
    }
  } catch (e) {
    console.warn('[ACCOUNTING] Paiements fournisseurs ignorés:', e.message);
  }

  // 7. Insertion en masse
  let inserted = 0;
  const COLS = `(entity, piece_num, doc_date, doc_type, doc_ref, fk_doc, fk_docdet,
    thirdparty_code, subledger_account, subledger_label, numero_compte, label_compte,
    label_operation, debit, credit, montant, sens, fk_user_author, date_creation,
    code_journal, journal_label, import_key)`;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const [r] = await conn.query(
      `INSERT INTO llx_accounting_bookkeeping ${COLS} VALUES ?`, [chunk]
    );
    inserted += r.affectedRows || chunk.length;
  }

  await conn.commit();

  if (suspenseHits > 0) {
    warnings.push(
      `${suspenseHits} règlement(s) sans compte bancaire identifiable ont été ventilés ` +
      `sur le compte d'attente ${acc.suspense} — à régulariser.`
    );
  }

  return {
    deleted: del.affectedRows || 0,
    inserted,
    pieces: invoices.length + payments.length + supplierInvoices.length + breakdown.purchase_payments,
    breakdown,
    warnings,
    period: { from: date_from, to: date_to },
  };

  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

/** Résumé de l'état du grand livre. */
export async function getTransferSummary(pool) {
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS nb_lines, COUNT(DISTINCT piece_num) AS nb_pieces,
            SUM(CASE WHEN import_key = 'AUTOGEN' THEN 1 ELSE 0 END) AS auto_lines,
            SUM(CASE WHEN import_key IS NULL OR import_key = '' THEN 1 ELSE 0 END) AS manual_lines,
            MIN(doc_date) AS first_date, MAX(doc_date) AS last_date,
            MAX(date_creation) AS last_run
     FROM llx_accounting_bookkeeping WHERE entity = ?`,
    [ENTITY]
  );
  const [byJournal] = await pool.query(
    `SELECT code_journal, journal_label, COUNT(*) AS nb_lines,
            COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
     FROM llx_accounting_bookkeeping WHERE entity = ?
     GROUP BY code_journal ORDER BY code_journal`,
    [ENTITY]
  );
  return {
    lines: Number(counts.nb_lines || 0),
    pieces: Number(counts.nb_pieces || 0),
    auto_lines: Number(counts.auto_lines || 0),
    manual_lines: Number(counts.manual_lines || 0),
    first_date: counts.first_date,
    last_date: counts.last_date,
    last_run: counts.last_run,
    by_journal: byJournal.map(j => ({
      code: j.code_journal,
      label: j.journal_label,
      lines: Number(j.nb_lines),
      debit: Math.round(Number(j.debit)),
      credit: Math.round(Number(j.credit)),
    })),
  };
}
