// QZ Tray bridge — connexion au service local d'impression thermique.
// QZ Tray écoute sur ws://localhost:8181 (ou wss://localhost:8181 selon setup).
// Sans certificat signé, une popup de confirmation apparaît à la première impression
// puis l'utilisateur peut cocher "Autoriser toujours pour ce site".
import qz from 'qz-tray';

let connectingPromise = null;

export async function connectQz() {
  if (qz.websocket.isActive()) return true;
  if (connectingPromise) return connectingPromise;

  // Mode unsigned — les requêtes d'impression afficheront une popup QZ Tray
  // la première fois. L'utilisateur peut autoriser le site de manière permanente.
  qz.security.setCertificatePromise((resolve) => resolve());
  qz.security.setSignaturePromise(() => (resolve) => resolve());

  connectingPromise = qz.websocket.connect({ retries: 0, delay: 1 })
    .then(() => true)
    .catch((err) => {
      // Pas installé, pas lancé, ou port bloqué
      throw new Error(`QZ Tray indisponible : ${err?.message || err}`);
    })
    .finally(() => { connectingPromise = null; });

  return connectingPromise;
}

export async function disconnectQz() {
  if (qz.websocket.isActive()) {
    try { await qz.websocket.disconnect(); } catch { /* noop */ }
  }
}

export function isQzConnected() {
  return qz.websocket.isActive();
}

export async function listQzPrinters() {
  if (!qz.websocket.isActive()) await connectQz();
  return qz.printers.find(); // array de noms
}

// Trouve automatiquement une imprimante Epson TM-* si aucune n'est pré-configurée
export async function detectEpsonPrinter() {
  const all = await listQzPrinters();
  const match = all.find((n) => /tm-?t(20|88)|tm-?t\d|epson.*receipt/i.test(n))
    || all.find((n) => /receipt|thermal/i.test(n))
    || all[0];
  return match || null;
}

// Imprime des bytes bruts ESC/POS sur l'imprimante nommée
export async function printRaw(printerName, bytes) {
  if (!qz.websocket.isActive()) await connectQz();
  const config = qz.configs.create(printerName, { encoding: 'Windows-1252' });
  // bytes peut être une string ou un Uint8Array. On passe en "hex" pour Uint8Array.
  const data = bytes instanceof Uint8Array
    ? [{ type: 'raw', format: 'hex', data: uint8ToHex(bytes) }]
    : [{ type: 'raw', format: 'plain', data: String(bytes) }];
  await qz.print(config, data);
}

function uint8ToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}
