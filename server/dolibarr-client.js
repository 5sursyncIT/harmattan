import axios from 'axios';

const DOLIBARR_BASE = process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php';
const API_KEY = process.env.DOLIBARR_API_KEY;
if (!API_KEY) console.warn('[SECURITY] DOLIBARR_API_KEY non définie — les requêtes Dolibarr échoueront');

const dolibarrApi = axios.create({
  baseURL: DOLIBARR_BASE,
  headers: {
    'DOLAPIKEY': API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Log requests in dev
dolibarrApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      console.error(`[DOLIBARR] ${error.config?.method?.toUpperCase()} ${error.config?.url} → ${error.response.status}`);
    } else {
      console.error(`[DOLIBARR] Request failed:`, error.message);
    }
    return Promise.reject(error);
  }
);

export { dolibarrApi, DOLIBARR_BASE, API_KEY };
