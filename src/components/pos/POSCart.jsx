import { useEffect, useState } from 'react';
import usePosCartStore from '../../store/posCartStore';
import { FiMinus, FiPlus, FiTrash2, FiPause, FiPlay, FiUser, FiFileText, FiPercent, FiArrowLeft, FiHash, FiTag, FiDelete, FiCheckCircle, FiChevronRight } from 'react-icons/fi';
import './POSCart.css';

export default function POSCart({ onPay, onQuote, onSelectCustomer, onBackToCatalog, showBackButton = false, isProMode = false }) {
  const items = usePosCartStore((s) => s.items);
  const customer = usePosCartStore((s) => s.customer);
  const held = usePosCartStore((s) => s.held);
  const updateQty = usePosCartStore((s) => s.updateQty);
  const removeItem = usePosCartStore((s) => s.removeItem);
  const setDiscount = usePosCartStore((s) => s.setDiscount);
  const clearTicket = usePosCartStore((s) => s.clearTicket);
  const holdTicket = usePosCartStore((s) => s.holdTicket);
  const recallTicket = usePosCartStore((s) => s.recallTicket);
  const getTotal = usePosCartStore((s) => s.getTotal);

  const total = getTotal();
  const itemCount = items.reduce((sum, item) => sum + item.qty, 0);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [editorMode, setEditorMode] = useState('qty');
  const [keypadValue, setKeypadValue] = useState('');

  const selectedItem = items.find((item) => item.product_id === selectedItemId) || null;

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      if (!items.length) {
        setSelectedItemId(null);
        setKeypadValue('');
        return;
      }

      if (!selectedItemId || !items.some((item) => item.product_id === selectedItemId)) {
        setSelectedItemId(items[0].product_id);
        setKeypadValue('');
      }
    }, 0);

    return () => clearTimeout(syncTimer);
  }, [items, selectedItemId]);

  const displayedValue = selectedItem
    ? (keypadValue || String(editorMode === 'qty' ? selectedItem.qty : selectedItem.discount || 0))
    : '--';

  const handleSelectItem = (productId) => {
    setSelectedItemId(productId);
    setKeypadValue('');
  };

  const handleModeChange = (mode) => {
    setEditorMode(mode);
    setKeypadValue('');
  };

  const handleDigit = (digit) => {
    if (!selectedItem) return;
    setKeypadValue((current) => {
      const nextValue = current === '0' ? digit : `${current}${digit}`;
      return nextValue.slice(0, 3);
    });
  };

  const handleBackspace = () => {
    setKeypadValue((current) => current.slice(0, -1));
  };

  const handleClearInput = () => {
    setKeypadValue('');
  };

  const applyEditorValue = (value = keypadValue) => {
    if (!selectedItem) return;

    const parsedValue = Number(value);
    if (Number.isNaN(parsedValue)) return;

    if (editorMode === 'qty') {
      updateQty(selectedItem.product_id, Math.max(1, parsedValue));
    } else {
      setDiscount(selectedItem.product_id, Math.max(0, Math.min(100, parsedValue)));
    }

    setKeypadValue('');
  };

  const quickOperatorActions = [
    {
      key: 'qty',
      label: 'Qté',
      icon: <FiHash size={15} />,
      active: editorMode === 'qty',
      onClick: () => handleModeChange('qty'),
    },
    {
      key: 'discount',
      label: 'Remise',
      icon: <FiTag size={15} />,
      active: editorMode === 'discount',
      onClick: () => handleModeChange('discount'),
    },
    {
      key: 'plus',
      label: '+1',
      icon: <FiPlus size={15} />,
      disabled: !selectedItem,
      onClick: () => selectedItem && updateQty(selectedItem.product_id, selectedItem.qty + 1),
    },
    {
      key: 'remove',
      label: 'Suppr.',
      icon: <FiTrash2 size={15} />,
      disabled: !selectedItem,
      onClick: () => selectedItem && removeItem(selectedItem.product_id),
    },
  ];

  const keypadButtons = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

  return (
    <div className={`pos-cart ${isProMode ? 'pro-mode' : ''}`}>
      <div className="pos-cart-header">
        <div className="pos-cart-header-main">
          <h3>Ticket</h3>
          <span className="pos-cart-subtitle">
            Vue d’encaissement {isProMode ? 'pro' : 'rapide'}
          </span>
        </div>
        <div className="pos-cart-header-side">
          <div className="pos-cart-header-actions">
          {showBackButton && (
            <button type="button" className="pos-cart-back" onClick={onBackToCatalog}>
              <FiArrowLeft size={14} />
              Catalogue
            </button>
          )}
          {items.length > 0 && (
            <button className="pos-cart-clear" onClick={() => {
              if (confirm('Vider le ticket en cours ?')) clearTicket();
            }}>Vider</button>
          )}
          </div>
        </div>
      </div>

      {held.length > 0 && (
        <div className="pos-cart-held">
          <span className="pos-cart-section-label">Tickets en attente</span>
          {held.map((t, i) => (
            <button key={i} className="pos-cart-held-btn" onClick={() => {
              if (items.length > 0 && !confirm('Le ticket actuel sera remplacé. Continuer ?')) return;
              recallTicket(i);
            }}>
              <FiPlay size={10} />
              Ticket #{i + 1} ({t.items.length} art.)
            </button>
          ))}
        </div>
      )}

      <button className="pos-cart-customer" onClick={onSelectCustomer}>
        <span className="pos-cart-customer-icon"><FiUser /></span>
        <span className="pos-cart-customer-copy">
          <strong>{customer ? customer.name : 'Client comptoir'}</strong>
          <small>{customer ? 'Client sélectionné' : 'Associer un client au ticket'}</small>
        </span>
        <FiChevronRight size={16} />
      </button>

      <div className={`pos-cart-workspace ${isProMode ? 'pro-mode' : ''}`}>
        <section className="pos-cart-main-panel">
          <div className="pos-cart-panel-header">
            <div>
              <span className="pos-cart-section-label">Lignes du ticket</span>
              <strong>{items.length > 0 ? 'Panier en cours' : 'Panier vide'}</strong>
            </div>
            <span className={`pos-cart-selection-chip ${selectedItem ? 'active' : ''}`}>
              {selectedItem ? `Sélection : ${selectedItem.label}` : 'Touchez une ligne pour l’éditer'}
            </span>
          </div>

          <div className="pos-cart-items">
          {items.length === 0 ? (
            <div className="pos-cart-empty">
              <div className="pos-cart-empty-copy">
                <strong>Aucun article dans le ticket</strong>
                <p>Scannez ou recherchez un produit pour commencer l’encaissement.</p>
              </div>
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.product_id}
                className={`pos-cart-item ${selectedItemId === item.product_id ? 'selected' : ''}`}
                onClick={() => handleSelectItem(item.product_id)}
              >
                <div className="pos-cart-item-info">
                  <span className="pos-cart-item-ref">{item.ref}</span>
                  <span className="pos-cart-item-label">{item.label}</span>
                  <span className="pos-cart-item-price">
                    {parseInt(item.price_ttc, 10).toLocaleString('fr-FR')} F / unité
                    {item.discount > 0 && <span className="pos-cart-item-discount-tag">-{item.discount}%</span>}
                  </span>
                </div>
                <div className="pos-cart-item-actions">
                  <button
                    type="button"
                    aria-label={`Réduire la quantité de ${item.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateQty(item.product_id, item.qty - 1);
                    }}
                  >
                    <FiMinus size={14} />
                  </button>
                  <span className="pos-cart-item-qty">{item.qty}</span>
                  <button
                    type="button"
                    aria-label={`Augmenter la quantité de ${item.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateQty(item.product_id, item.qty + 1);
                    }}
                  >
                    <FiPlus size={14} />
                  </button>
                  <button
                    type="button"
                    className="pos-cart-item-discount-btn"
                    aria-label={`Appliquer une remise à ${item.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isProMode) {
                        handleSelectItem(item.product_id);
                        handleModeChange('discount');
                      } else {
                        const val = prompt('Remise en % (0-100) :', item.discount || 0);
                        if (val !== null) setDiscount(item.product_id, parseInt(val) || 0);
                      }
                    }}
                    title="Remise"
                  >
                    <FiPercent size={14} />
                  </button>
                  <button
                    type="button"
                    className="pos-cart-item-remove"
                    aria-label={`Supprimer ${item.label} du ticket`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeItem(item.product_id);
                    }}
                  >
                    <FiTrash2 size={14} />
                  </button>
                </div>
                <span className="pos-cart-item-total">
                  {Math.round(item.line_total).toLocaleString('fr-FR')} F
                </span>
              </div>
            ))
          )}
          </div>
        </section>

        {isProMode && (
          <aside className="pos-cart-pro-panel">
            <div className="pos-cart-pro-header">
              <span className="pos-cart-pro-eyebrow">Caisse pro</span>
              <strong className="pos-cart-pro-title">Clavier opérateur</strong>
              <span className="pos-cart-pro-description">Raccourcis visibles, saisie directe et actions de caisse sans détour.</span>
            </div>

            <div className="pos-cart-pro-selection">
              <span className="pos-cart-pro-selection-label">Article sélectionné</span>
              <strong className="pos-cart-pro-selection-value">
                {selectedItem ? selectedItem.label : 'Sélectionnez une ligne'}
              </strong>
              <span className="pos-cart-pro-selection-meta">
                {selectedItem
                  ? `${selectedItem.qty} unité${selectedItem.qty > 1 ? 's' : ''} · ${selectedItem.discount || 0}% remise`
                  : 'Choisissez un article pour éditer sa quantité ou sa remise'}
              </span>
            </div>

            <div className="pos-cart-pro-shortcuts">
              {quickOperatorActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={`pos-cart-pro-shortcut ${action.active ? 'active' : ''}`}
                  onClick={action.onClick}
                  disabled={action.disabled}
                  aria-pressed={action.active}
                >
                  <span>{action.icon}</span>
                  <span>{action.label}</span>
                </button>
              ))}
            </div>

            <div className="pos-cart-keypad-shell">
              <div className="pos-cart-keypad-display">
                <span className="pos-cart-keypad-mode">
                  {editorMode === 'qty' ? 'Quantité' : 'Remise %'}
                </span>
                <strong>{displayedValue}</strong>
              </div>

              <div className="pos-cart-keypad-grid">
                {keypadButtons.slice(0, 9).map((digit) => (
                  <button key={digit} type="button" onClick={() => handleDigit(digit)} disabled={!selectedItem}>
                    {digit}
                  </button>
                ))}
                <button type="button" onClick={handleClearInput} disabled={!selectedItem}>C</button>
                <button type="button" onClick={() => handleDigit('0')} disabled={!selectedItem}>0</button>
                <button type="button" onClick={handleBackspace} disabled={!selectedItem}>
                  <FiDelete size={16} />
                </button>
              </div>

              <button
                type="button"
                className="pos-cart-keypad-apply"
                onClick={() => applyEditorValue()}
                disabled={!selectedItem}
              >
                <FiCheckCircle size={16} />
                Appliquer {editorMode === 'qty' ? 'la quantité' : 'la remise'}
              </button>
            </div>
          </aside>
        )}
      </div>

      <div className="pos-cart-footer">
        <div className="pos-cart-footer-info">
          <div className="pos-cart-total">
            <span>Total à payer</span>
            <strong>{total.toLocaleString('fr-FR')} FCFA</strong>
          </div>
          <span className="pos-cart-footer-sub">
            {items.length} ligne{items.length > 1 ? 's' : ''} · {itemCount} unité{itemCount > 1 ? 's' : ''}
          </span>
        </div>

        <div className={`pos-cart-actions ${isProMode ? 'pro-mode' : ''}`}>
          {items.length > 0 && (
            <>
              <button className="pos-cart-hold" onClick={holdTicket} title="Mettre en attente">
                <FiPause />
              </button>
              <button className="pos-cart-quote" onClick={onQuote} title="Créer un proforma">
                <FiFileText />
              </button>
            </>
          )}
          <button
            className="pos-cart-pay"
            onClick={onPay}
            disabled={items.length === 0}
          >
            ENCAISSER
          </button>
        </div>
      </div>
    </div>
  );
}
