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

// Retry config: idempotent methods only, transient errors only
const RETRYABLE_METHODS = new Set(['get', 'head', 'options']);
const RETRYABLE_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 250;

function isRetryable(error) {
  if (!error.config) return false;
  const method = (error.config.method || 'get').toLowerCase();
  if (!RETRYABLE_METHODS.has(method)) return false;
  if (error.code && RETRYABLE_CODES.has(error.code)) return true;
  if (error.response && error.response.status >= 500) return true;
  return false;
}

dolibarrApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (config && isRetryable(error)) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      if (config.__retryCount <= MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, config.__retryCount - 1);
        console.warn(`[DOLIBARR] Retry ${config.__retryCount}/${MAX_RETRIES} ${config.method?.toUpperCase()} ${config.url} après ${delay}ms (${error.code || error.response?.status})`);
        await new Promise((r) => setTimeout(r, delay));
        return dolibarrApi.request(config);
      }
    }

    if (error.response) {
      console.error(`[DOLIBARR] ${error.config?.method?.toUpperCase()} ${error.config?.url} → ${error.response.status}`);
    } else {
      console.error(`[DOLIBARR] Request failed:`, error.message);
    }
    return Promise.reject(error);
  }
);

export { dolibarrApi, DOLIBARR_BASE, API_KEY };
