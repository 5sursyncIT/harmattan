import { useEffect, useState } from 'react';
import { FiX, FiPrinter, FiCheckCircle, FiAlertTriangle, FiRefreshCw, FiPlay } from 'react-icons/fi';
import toast from 'react-hot-toast';
import usePosPrinterStore from '../../store/posPrinterStore';
import { connectQz, listQzPrinters, isQzConnected } from '../../pos/qz';
import { printTestTicket } from '../../pos/printReceipt';
import './POSPrinterSettings.css';

export default function POSPrinterSettings({ onClose }) {
  const cfg = usePosPrinterStore();
  const [printers, setPrinters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      if (!isQzConnected()) await connectQz();
      const list = await listQzPrinters();
      setPrinters(list || []);
      cfg.setConnection({ qzAvailable: true });
    } catch (err) {
      cfg.setConnection({ qzAvailable: false, lastError: String(err?.message || err) });
      toast.error("QZ Tray n'est pas joignable. Vérifiez qu'il est installé et en cours d'exécution.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh();   }, []);

  const handleTest = async () => {
    setTesting(true);
    try { await printTestTicket(); } finally { setTesting(false); }
  };

  return (
    <div className="pos-settings-overlay" onClick={onClose}>
      <div className="pos-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pos-settings-header">
          <h3><FiPrinter /> Imprimante thermique</h3>
          <button className="pos-settings-close" onClick={onClose}><FiX /></button>
        </div>

        <div className="pos-settings-body">
          <div className={`pos-settings-status ${cfg.qzAvailable ? 'ok' : 'ko'}`}>
            {cfg.qzAvailable ? (
              <><FiCheckCircle /> QZ Tray connecté</>
            ) : (
              <><FiAlertTriangle /> QZ Tray non détecté</>
            )}
          </div>

          {!cfg.qzAvailable && (
            <div className="pos-settings-hint">
              Pour activer l'impression thermique directe (silencieuse, &lt; 1 s), installez{' '}
              <a href="https://qz.io/download/" target="_blank" rel="noreferrer">QZ Tray</a>{' '}
              sur ce poste et autorisez ce site à imprimer. Sans QZ Tray, l'impression passera par le dialogue du navigateur.
            </div>
          )}

          <div className="pos-settings-field">
            <label>Imprimante</label>
            <div className="pos-settings-field-row">
              <select
                value={cfg.printerName}
                onChange={(e) => cfg.setConfig({ printerName: e.target.value })}
                disabled={!cfg.qzAvailable || loading}
              >
                <option value="">— Choisir une imprimante —</option>
                {printers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="pos-settings-btn" onClick={refresh} disabled={loading} title="Actualiser la liste">
                <FiRefreshCw className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>

          <div className="pos-settings-field">
            <label>Largeur du papier</label>
            <div className="pos-settings-radio-group">
              <label>
                <input type="radio" name="w" checked={cfg.paperWidth === 80}
                  onChange={() => cfg.setConfig({ paperWidth: 80 })} />
                80 mm (48 col.)
              </label>
              <label>
                <input type="radio" name="w" checked={cfg.paperWidth === 58}
                  onChange={() => cfg.setConfig({ paperWidth: 58 })} />
                58 mm (32 col.)
              </label>
            </div>
          </div>

          <label className="pos-settings-toggle">
            <input type="checkbox" checked={cfg.autoPrint}
              onChange={(e) => cfg.setConfig({ autoPrint: e.target.checked })} />
            <span>Imprimer automatiquement après encaissement</span>
          </label>

          <label className="pos-settings-toggle">
            <input type="checkbox" checked={cfg.openCashDrawer}
              onChange={(e) => cfg.setConfig({ openCashDrawer: e.target.checked })} />
            <span>Ouvrir le tiroir-caisse sur paiement espèces</span>
          </label>

          {cfg.lastError && (
            <div className="pos-settings-error">Dernière erreur : {cfg.lastError}</div>
          )}
        </div>

        <div className="pos-settings-footer">
          <button className="pos-settings-btn-secondary" onClick={onClose}>Fermer</button>
          <button
            className="pos-settings-btn-primary"
            onClick={handleTest}
            disabled={!cfg.qzAvailable || !cfg.printerName || testing}
          >
            <FiPlay /> {testing ? 'Impression…' : 'Imprimer un ticket de test'}
          </button>
        </div>
      </div>
    </div>
  );
}
