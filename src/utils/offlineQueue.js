const QUEUE_KEY = 'senharmattan-pos-offline-queue';
const FAILED_KEY = 'senharmattan-pos-offline-failed';
const MAX_ATTEMPTS = 5;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}

function write(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
}

function genQid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* fallback ci-dessous */ }
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Met une vente en file d'attente hors ligne. Renvoie le nombre d'éléments en file.
export function enqueueSale(saleData) {
  const queue = read(QUEUE_KEY);
  queue.push({ ...saleData, _qid: genQid(), queued_at: new Date().toISOString(), attempts: 0 });
  write(QUEUE_KEY, queue);
  return queue.length;
}

export function getPendingSales() { return read(QUEUE_KEY); }

// Ventes hors ligne définitivement rejetées par le serveur — à régulariser à la main.
export function getFailedSales() { return read(FAILED_KEY); }

export function clearAllPending() { write(QUEUE_KEY, []); }

export function clearFailedSales() { write(FAILED_KEY, []); }

let syncing = false;

/**
 * Resynchronise les ventes hors ligne.
 *  - succès               → retirée de la file
 *  - erreur réseau        → on arrête (toujours hors ligne), la file est conservée
 *  - 409 (vente en cours) → conservée, nouvelle tentative ultérieure
 *  - 5xx                  → nouvelle tentative jusqu'à MAX_ATTEMPTS, puis abandon
 *  - 4xx                  → abandon immédiat (le payload ne passera jamais)
 * Une vente en échec ne bloque plus la synchronisation des suivantes.
 *
 * @returns {{synced:number, failed:number, pending:number}}
 */
export async function syncOfflineSales(posCreateSale, { onSuccess, onPermanentFail } = {}) {
  if (syncing) return { synced: 0, failed: 0, pending: 0 };
  const queue = read(QUEUE_KEY);
  if (queue.length === 0) return { synced: 0, failed: 0, pending: 0 };

  syncing = true;
  let synced = 0;
  const stillPending = [];
  const newlyFailed = [];

  try {
    for (let i = 0; i < queue.length; i++) {
      const sale = queue[i];
      try {
        const result = await posCreateSale(sale);
        synced++;
        onSuccess?.(result.data, sale);
      } catch (err) {
        if (!err.response) {
          // Réseau coupé : inutile de continuer — on conserve cette vente et
          // toutes les suivantes pour le prochain passage.
          stillPending.push(...queue.slice(i));
          break;
        }
        const status = err.response.status;
        if (status === 409) {
          stillPending.push(sale); // vente déjà en cours côté serveur — transitoire
          continue;
        }
        sale.attempts = (sale.attempts || 0) + 1;
        sale.last_error = err.response?.data?.error || `Erreur ${status}`;
        if (status >= 500 && sale.attempts < MAX_ATTEMPTS) {
          stillPending.push(sale); // erreur serveur — nouvelle tentative plus tard
        } else {
          newlyFailed.push(sale); // 4xx, ou trop d'échecs — abandon définitif
        }
      }
    }
  } finally {
    write(QUEUE_KEY, stillPending);
    if (newlyFailed.length) write(FAILED_KEY, [...read(FAILED_KEY), ...newlyFailed]);
    syncing = false;
  }

  newlyFailed.forEach((s) => onPermanentFail?.(s));
  return { synced, failed: newlyFailed.length, pending: stillPending.length };
}
