import { useEffect, useRef } from 'react';
import './ConfirmModal.css';

/**
 * Modale de confirmation accessible.
 * - role="dialog", aria-modal, aria-labelledby/describedby
 * - Focus trap Tab/Shift+Tab
 * - Esc pour fermer
 * - Restauration du focus au démontage
 * - autoFocus sur le bouton confirm
 */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const modalRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    setTimeout(() => confirmBtnRef.current?.focus(), 0);

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Tab') {
        const root = modalRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused.current && previouslyFocused.current.focus) {
        previouslyFocused.current.focus();
      }
    };
  }, [onCancel]);

  return (
    <div className="confirm-modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="confirm-modal"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
      >
        <h3 id="confirm-modal-title">{title}</h3>
        <p id="confirm-modal-message">{message}</p>
        <div className="confirm-modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            className={danger ? 'btn-icon danger' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
