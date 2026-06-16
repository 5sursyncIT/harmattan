/**
 * Enregistrement des paiements de facture Dolibarr — point d'entrée UNIQUE.
 *
 * ⚠️ NE JAMAIS utiliser `POST /invoices/{id}/payments` (méthode REST
 * `addPayment`) pour un règlement fractionné. Cet endpoint IGNORE totalement
 * tout montant transmis (`amount`) et impute systématiquement le
 * reste-à-payer COMPLET de la facture (`$resteapayer`, cf.
 * htdocs/compta/facture/class/api_invoices.class.php::addPayment). Résultat :
 * chaque méthode d'un paiement fractionné imputait le total entier
 * → sur-paiement (ex. facture 125 000 réglée Wave+Espèces = 250 000 encaissés).
 *
 * Le SEUL endpoint REST qui respecte le montant par facture est
 * `POST /invoices/paymentsdistributed` (`addPaymentDistributed`) : il lit le
 * montant explicite dans `arrayofamounts` (ligne ~1628) ET refuse tout montant
 * supérieur au reste-à-payer (garde anti-sur-paiement, ligne ~1635) — ce qui
 * protège même en cas de ré-entrée concurrente.
 *
 * Historique : bug découvert le 2026-06-04 puis ré-apparu le 2026-06-06 car le
 * « correctif » s'était contenté d'ajouter `amount` à `addPayment` (sans effet).
 * Centralisé ici pour empêcher toute nouvelle divergence.
 */

/**
 * Enregistre UN paiement (une méthode) sur une facture, du montant EXACT
 * demandé. Retourne l'id du paiement créé (rowid llx_paiement).
 *
 * @param {import('axios').AxiosInstance} adminApi  client Dolibarr (clé admin)
 * @param {object} p
 * @param {number} p.invoiceId            rowid de la facture
 * @param {number} p.amount               montant à imputer (devise de la facture)
 * @param {number} p.paymentId            id Dolibarr du mode de paiement (llx_c_paiement.id)
 * @param {number} p.accountId            id du compte bancaire (llx_bank_account)
 * @param {number} p.datepaye             date de paiement (epoch secondes)
 * @param {boolean} [p.isLast=true]       solde la facture (closepaidinvoices) si dernier split
 * @param {string} [p.numPayment]         numéro de paiement (réf.)
 * @param {string} [p.comment]            note privée
 * @param {string} [p.chqemetteur]        émetteur du chèque (obligatoire si mode = CHQ)
 * @param {string} [p.chqbank]            banque émettrice (optionnel)
 * @returns {Promise<number>} id du paiement créé
 */
export async function recordInvoicePayment(adminApi, {
  invoiceId, amount, paymentId, accountId, datepaye,
  isLast = true, numPayment, comment, chqemetteur, chqbank,
}) {
  const body = {
    // Clé = id facture ; on fixe le montant EXACT (Dolibarr le respecte ici).
    arrayofamounts: { [invoiceId]: { amount: String(amount), multicurrency_amount: '' } },
    datepaye,
    paymentid: paymentId,
    closepaidinvoices: isLast ? 'yes' : 'no',
    accountid: accountId,
    num_payment: numPayment || undefined,
    comment,
  };
  if (chqemetteur) body.chqemetteur = chqemetteur;
  if (chqbank) body.chqbank = chqbank;
  const r = await adminApi.post('/invoices/paymentsdistributed', body);
  return r.data;
}

/**
 * Résout un code de mode de paiement (LIQ/CB/CHQ/WAVE/OM/VIR) en son id entier
 * Dolibarr (llx_c_paiement.id) — requis par v21 qui n'accepte plus le code seul.
 * Cache mémoire (les ids sont stables). Centralisé ici pour rester l'unique
 * source de vérité de l'enregistrement des paiements.
 *
 * @param {any} pool  pool mysql2 (dolibarrPool)
 * @param {string} code  code du mode de paiement
 * @returns {Promise<number|null>}
 */
const paymentIdCache = new Map();
export async function resolvePaymentId(pool, code) {
  const key = String(code || '').toUpperCase();
  if (paymentIdCache.has(key)) return paymentIdCache.get(key);
  const [rows] = await pool.query('SELECT id FROM llx_c_paiement WHERE code = ? LIMIT 1', [key]);
  const id = rows[0]?.id ? Number(rows[0].id) : null;
  if (id) paymentIdCache.set(key, id);
  return id;
}
