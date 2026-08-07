/**
 * Régénération du document d'un contrat (ODT + PDF) via le module Dolibarr maison.
 *
 * Extrait de contract-routes.js parce que DEUX modules en ont besoin : la fiche
 * contrat (validation, modification) et les devis de contribution — un devis
 * recopie ses valeurs négociées sur le contrat (quantité d'exemplaires, remise),
 * or ces valeurs alimentent l'ANNEXE « Engagement d'achat de l'Auteur ». Sans
 * régénération, le PDF continue d'annoncer les anciennes valeurs : c'est
 * exactement le cas du contrat CT2607-0075, dont l'annexe affichait « 0
 * exemplaires » alors que l'extrafield portait bien 50.
 */
import 'dotenv/config';
import axios from 'axios';
import { adminApi } from './dolibarr-admin-client.js';

const DOLIBARR_WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';
const BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/contract-builddoc.php';

export async function rebuildContractDocument(contractId) {
  if (!DOLIBARR_WEBHOOK_SECRET) throw new Error('DOLIBARR_WEBHOOK_SECRET non configuré');
  const { data } = await axios.post(BUILDDOC_URL, { contract_id: contractId }, {
    headers: { 'X-Dolibarr-Secret': DOLIBARR_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return data;
}

/**
 * Documents Dolibarr d'un contrat. Dolibarr répond 404 quand il n'y en a aucun —
 * traité comme liste vide : un brouillon sans PDF n'est pas une erreur.
 */
export async function listContractDocuments(contractId) {
  try {
    const res = await adminApi.get('/documents', { params: { modulepart: 'contract', id: contractId } });
    return res.data || [];
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw err;
  }
}

/**
 * Régénère le document SEULEMENT s'il en existe déjà un.
 *
 * Un contrat sans document n'en a pas besoin : le PDF naît à la validation, avec
 * les valeurs du moment. En revanche, dès qu'un document existe, toute écriture
 * sur les extrafields qu'il imprime le rend périmé — et un contrat périmé
 * téléchargeable est pire qu'un contrat absent.
 *
 * Best-effort assumé : la donnée en base est déjà écrite et fait foi ; un échec
 * de rendu (soffice occupé, secret absent) ne doit jamais annuler l'opération
 * métier appelante. Renvoie true si le document a effectivement été refait.
 */
export async function refreshContractDocumentIfAny(contractId, { context = 'modification' } = {}) {
  try {
    if ((await listContractDocuments(contractId)).length === 0) return false;
    await rebuildContractDocument(contractId);
    return true;
  } catch (err) {
    console.warn(`[CONTRACTS] Régénération document (${context}, contrat ${contractId}) :`, err.response?.data || err.message);
    return false;
  }
}
