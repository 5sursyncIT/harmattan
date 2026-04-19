import { FiBook, FiGlobe, FiUsers, FiAward } from 'react-icons/fi';
import './AboutPage.css';

export default function AboutPage() {
  return (
    <div className="about-page">
      <div className="about-hero">
        <div className="container">
          <h1>À propos de Sen Harmattan</h1>
          <p>Maison d'édition et librairie au service de la littérature africaine</p>
        </div>
      </div>

      <div className="container">
        <section className="about-section">
          <h2 className="section-title">Notre histoire</h2>
          <p>
            Sen Harmattan est une maison d'édition et librairie basée à Dakar, au Sénégal.
            Filiale des Éditions L'Harmattan, nous sommes dédiés à la promotion et la diffusion
            de la littérature africaine et internationale. Notre catalogue riche de plus de
            6 000 ouvrages couvre une diversité de genres : romans, essais, poésie, théâtre,
            littérature jeunesse et ouvrages académiques.
          </p>
        </section>

        <div className="about-values">
          <div className="value-card">
            <FiBook size={36} />
            <h3>+6 000 ouvrages</h3>
            <p>Un catalogue riche et varié couvrant tous les genres littéraires</p>
          </div>
          <div className="value-card">
            <FiGlobe size={36} />
            <h3>Rayonnement africain</h3>
            <p>Promotion de la littérature du continent africain à travers le monde</p>
          </div>
          <div className="value-card">
            <FiUsers size={36} />
            <h3>Auteurs reconnus</h3>
            <p>Collaboration avec des centaines d'auteurs africains et internationaux</p>
          </div>
          <div className="value-card">
            <FiAward size={36} />
            <h3>Qualité éditoriale</h3>
            <p>Un engagement constant pour l'excellence dans l'édition</p>
          </div>
        </div>

        <section className="about-section">
          <h2 className="section-title">Notre mission</h2>
          <p>
            Notre mission est de rendre accessible la richesse de la production littéraire
            africaine. Nous croyons au pouvoir des livres pour éduquer, inspirer et connecter
            les peuples. À travers notre librairie en ligne, nous facilitons l'accès à nos
            publications pour les lecteurs du Sénégal et du monde entier.
          </p>
        </section>

        <section className="about-section">
          <h2 className="section-title">Nos engagements</h2>
          <ul className="about-list">
            <li>Soutenir les auteurs africains émergents et confirmés</li>
            <li>Offrir des prix accessibles pour démocratiser la lecture</li>
            <li>Garantir un service de livraison rapide et fiable</li>
            <li>Proposer des moyens de paiement adaptés (Orange Money, Wave, CB)</li>
            <li>Assurer un service client réactif et à l'écoute</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
