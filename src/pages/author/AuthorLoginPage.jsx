import { ClientLoginForm, AuthorLoginForm } from '../LoginPage';
import '../AuthPages.css';

export default function AuthorLoginPage() {
  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-grid">
          <AuthorLoginForm />
          <ClientLoginForm />
        </div>
      </div>
    </div>
  );
}
