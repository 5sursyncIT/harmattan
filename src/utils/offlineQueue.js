const QUEUE_KEY = 'senharmattan-pos-offline-queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function enqueueSale(saleData) {
  const queue = getQueue();
  queue.push({ ...saleData, queued_at: new Date().toISOString() });
  saveQueue(queue);
  return queue.length;
}

export function getPendingSales() {
  return getQueue();
}

export function clearProcessedSale(index) {
  const queue = getQueue();
  queue.splice(index, 1);
  saveQueue(queue);
}

export function clearAllPending() {
  saveQueue([]);
}

let syncing = false;

export async function syncOfflineSales(posCreateSale, onSuccess, onError) {
  if (syncing) return;
  const queue = getQueue();
  if (queue.length === 0) return;

  syncing = true;
  let processed = 0;

  for (let i = 0; i < queue.length; i++) {
    try {
      const result = await posCreateSale(queue[i]);
      onSuccess?.(result.data, queue[i]);
      processed++;
    } catch (err) {
      onError?.(err, queue[i]);
      break;
    }
  }

  // Remove processed sales from front of queue
  if (processed > 0) {
    const remaining = getQueue();
    remaining.splice(0, processed);
    saveQueue(remaining);
  }

  syncing = false;
  return processed;
}
