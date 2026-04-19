import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import usePosAuthStore from '../../store/posAuthStore';

export default function PosProtectedRoute({ children }) {
  const isAuthenticated = usePosAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(usePosAuthStore.persist.hasHydrated());

  useEffect(() => {
    if (hydrated) return;
    const unsub = usePosAuthStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, [hydrated]);

  // Wait for store rehydration before deciding
  if (!hydrated) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f172a', color: '#fff', fontFamily: 'system-ui' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#10b981', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ margin: 0, fontSize: '0.9rem', opacity: 0.7 }}>Chargement POS...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/pos/connexion" replace />;
  return children;
}
