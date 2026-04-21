import { Navigate } from 'react-router-dom';
import useAuthorAuthStore from '../../store/authorAuthStore';

export default function AuthorProtectedRoute({ children }) {
  const isAuthenticated = useAuthorAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/auteur/connexion" replace />;
  return children;
}
