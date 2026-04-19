import { useState } from 'react';
import { FiMail, FiCheckCircle, FiAlertCircle } from 'react-icons/fi';
import api from '../../api/dolibarr';
import './Newsletter.css';

export default function Newsletter() {
  const [email, setEmail] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [status, setStatus] = useState('idle'); // idle, loading, success, error
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!accepted) {
      setStatus('error');
      setMessage('Vous devez accepter les conditions d\'utilisation.');
      return;
    }
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus('error');
      setMessage('Adresse email invalide.');
      return;
    }
    
    setStatus('loading');
    
    try {
      const res = await api.post('/newsletter/subscribe', { email, accepted });
      setStatus('success');
      setMessage(res.data.message || 'Merci ! Un email de confirmation vous a été envoyé.');
      setEmail('');
      setAccepted(false);
    } catch (err) {
      setStatus('error');
      setMessage(err.response?.data?.error || 'Une erreur est survenue lors de l\'inscription.');
    }
  };

  return (
    <section className="newsletter-section">
      <div className="container newsletter-container">
        <div className="newsletter-content">
          <div className="newsletter-icon">
            <FiMail size={32} />
          </div>
          <h2>Abonnez-vous à notre newsletter</h2>
          <p>Restez informé(e) de nos dernières parutions, événements et promotions exclusives.</p>
        </div>
        
        <div className="newsletter-form-wrapper">
          <form onSubmit={handleSubmit} className="newsletter-form">
            <div className="newsletter-input-group">
              <input
                type="email"
                placeholder="Votre adresse email..."
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={status === 'loading'}
              />
              <button 
                type="submit" 
                className="btn btn-primary"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Inscription...' : 'S\'inscrire'}
              </button>
            </div>
            
            <div className="newsletter-checkbox">
              <input
                type="checkbox"
                id="newsletter-accept"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                disabled={status === 'loading'}
              />
              <label htmlFor="newsletter-accept">
                J'accepte de recevoir des emails et je reconnais avoir lu la politique de confidentialité.
              </label>
            </div>
          </form>
          
          {status === 'error' && (
            <div className="newsletter-message error">
              <FiAlertCircle /> {message}
            </div>
          )}
          
          {status === 'success' && (
            <div className="newsletter-message success">
              <FiCheckCircle /> {message}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
