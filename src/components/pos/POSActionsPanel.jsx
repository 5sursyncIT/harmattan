import { FiFilePlus, FiClock, FiPackage, FiPercent, FiScissors, FiCreditCard, FiDollarSign, FiBarChart2, FiLogIn, FiInbox, FiTrendingDown } from 'react-icons/fi';
import usePosCartStore from '../../store/posCartStore';
import './POSActionsPanel.css';

export default function POSActionsPanel({
  onNew,
  onHistory,
  onFreeProduct,
  onGlobalDiscount,
  onSplit,
  onPay,
  onPayCash,
  onUnpaid,
  onExpense,
  onCashReport,
  onCloseRegister,
}) {
  const items = usePosCartStore((s) => s.items);
  const hasItems = items.length > 0;

  const actions = [
    { key: 'new', label: 'Nouveau', icon: <FiFilePlus />, onClick: onNew, disabled: !hasItems },
    { key: 'history', label: 'Historique', icon: <FiClock />, onClick: onHistory },
    { key: 'free', label: 'Produit libre', icon: <FiPackage />, onClick: onFreeProduct },
    { key: 'discount', label: 'Remise fac.', icon: <FiPercent />, onClick: onGlobalDiscount, disabled: !hasItems },
    { key: 'split', label: 'Fractionner', icon: <FiScissors />, onClick: onSplit, disabled: !hasItems },
    { key: 'pay', label: 'Règlement', icon: <FiCreditCard />, onClick: onPay, disabled: !hasItems, primary: true },
    { key: 'cash', label: 'Paiement direct', icon: <FiDollarSign />, onClick: onPayCash, disabled: !hasItems, primary: true },
    { key: 'report', label: 'Rapport caisse', icon: <FiBarChart2 />, onClick: onCashReport },
    { key: 'unpaid', label: 'Encaisser impayé', icon: <FiInbox />, onClick: onUnpaid },
    { key: 'expense', label: "Sortie d'argent", icon: <FiTrendingDown />, onClick: onExpense },
    { key: 'close', label: 'Fermer caisse', icon: <FiLogIn />, onClick: onCloseRegister },
  ];

  return (
    <section className="pos-actions-panel" aria-label="Actions de caisse">
      <header className="pos-actions-header">
        <span className="pos-actions-eyebrow">Actions de caisse</span>
        <h3 className="pos-actions-title">Opérations</h3>
      </header>

      <div className="pos-actions-grid">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`pos-action-btn ${action.primary ? 'is-primary' : ''}`}
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.label}
          >
            <span className="pos-action-icon" aria-hidden="true">{action.icon}</span>
            <span className="pos-action-label">{action.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
