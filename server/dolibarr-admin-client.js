/**
 * Client Dolibarr avec clé ADMIN — opérations d'écriture sensibles
 * (création/validation de factures, enregistrement de règlements).
 *
 * La clé régulière (`dolibarr-client.js`, DOLIBARR_API_KEY) ne dispose pas des
 * droits d'écriture comptable ; ces opérations passent obligatoirement par la
 * clé admin (DOLIBARR_ADMIN_API_KEY). Point d'entrée partagé pour éviter de
 * recréer une instance axios par module.
 */
import axios from 'axios';

const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.warn('[DOLIBARR-ADMIN] DOLIBARR_ADMIN_API_KEY non définie — les écritures factures/paiements échoueront');
}

export const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: {
    DOLAPIKEY: ADMIN_API_KEY,
    'Content-Type': 'application/json',
    // Réponses non compressées : évite les erreurs zlib sur grosses réponses.
    'Accept-Encoding': 'identity',
  },
  timeout: 30000,
});
