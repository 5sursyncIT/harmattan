// Helper pour construire des liens deeplink vers les pages Dolibarr.
// L'URL de base est configurable via VITE_DOLIBARR_URL dans .env du frontend ;
// à défaut, on pointe sur le chemin Apache local /dolibarr/htdocs.

const BASE = (import.meta.env?.VITE_DOLIBARR_URL || '/dolibarr/htdocs').replace(/\/$/, '');

// Pages accountancy
export const dolibarrUrls = {
  chartOfAccounts: () => `${BASE}/accountancy/admin/account.php`,
  journals: () => `${BASE}/accountancy/admin/journals_list.php`,
  sellsJournal: () => `${BASE}/accountancy/journal/sellsjournal.php`,
  purchasesJournal: () => `${BASE}/accountancy/journal/purchasesjournal.php`,
  bankJournal: () => `${BASE}/accountancy/journal/bankjournal.php`,
  miscJournal: () => `${BASE}/accountancy/journal/variousjournal.php`,
  ledger: () => `${BASE}/accountancy/bookkeeping/listbyaccount.php`,
  balance: () => `${BASE}/accountancy/bookkeeping/balance.php`,
  generalLedger: () => `${BASE}/accountancy/bookkeeping/list.php`,
  transferAccounting: () => `${BASE}/accountancy/customer/list.php`,

  // Banque / trésorerie
  bankList: () => `${BASE}/compta/bank/list.php`,
  bankAccount: (id) => `${BASE}/compta/bank/card.php?id=${id}`,
  bankEntries: (accountId) => `${BASE}/compta/bank/bankentries_list.php?id=${accountId}`,
  reconciliation: (accountId) => `${BASE}/compta/bank/bankentries_list.php?action=reconciliation&id=${accountId}`,

  // TVA
  vatList: () => `${BASE}/compta/tva/list.php`,
  vatReport: (year) => `${BASE}/compta/tva/quadri_detail.php?year=${year || new Date().getFullYear()}`,

  // Factures et avoirs
  invoicesList: () => `${BASE}/compta/facture/list.php`,
  invoice: (id) => `${BASE}/compta/facture/card.php?facid=${id}`,
  creditNotesList: () => `${BASE}/compta/facture/list.php?type=2`,
  newCreditNote: (sourceInvoiceId) => `${BASE}/compta/facture/card.php?action=create&type=2${sourceInvoiceId ? `&fac_avoir=${sourceInvoiceId}&socid=auto` : ''}`,

  // Tiers (clients/fournisseurs)
  thirdparty: (id) => `${BASE}/societe/card.php?socid=${id}`,
  thirdpartiesClients: () => `${BASE}/societe/list.php?type=c`,
  thirdpartiesSuppliers: () => `${BASE}/societe/list.php?type=f`,

  // Paiements
  payment: (id) => `${BASE}/compta/paiement/card.php?id=${id}`,
  payments: () => `${BASE}/compta/paiement/list.php`,

  // Contrats
  contract: (id) => `${BASE}/contrat/card.php?id=${id}`,

  // Imports / exports
  importAccounting: () => `${BASE}/accountancy/bookkeeping/import.php`,
};

export const dolibarrBase = BASE;
