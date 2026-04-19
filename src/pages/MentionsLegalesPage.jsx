import './LegalPages.css';

export default function MentionsLegalesPage() {
  return (
    <div className="legal-page">
      <div className="container">
        <h1>Mentions Légales</h1>
        <p className="legal-date">Dernière mise à jour : Mars 2026</p>

        <section>
          <h2>Éditeur du site</h2>
          <p>
            <strong>Sen Harmattan</strong><br />
            Maison d'édition et librairie<br />
            10, Rue Tolbiac<br />
            Dakar, Sénégal<br />
            Téléphone : +221 33 821 10 96<br />
            Email : info@senharmattan.com
          </p>
        </section>

        <section>
          <h2>Directeur de la publication</h2>
          <p>Sen Harmattan - Direction générale</p>
        </section>

        <section>
          <h2>Hébergement</h2>
          <p>
            Le site est hébergé par :<br />
            Contabo GmbH<br />
            Aschauer Straße 32a<br />
            81549 München, Allemagne
          </p>
        </section>

        <section>
          <h2>Propriété intellectuelle</h2>
          <p>
            L'ensemble du contenu du site senharmattan.com (textes, images, logos, mise en page)
            est protégé par le droit d'auteur. Toute reproduction, même partielle, est interdite
            sans autorisation préalable écrite de Sen Harmattan.
          </p>
        </section>

        <section>
          <h2>Données personnelles</h2>
          <p>
            Les informations recueillies lors de la commande sont nécessaires au traitement
            de celle-ci. Elles sont conservées de manière sécurisée et ne sont pas transmises
            à des tiers, sauf nécessité liée à la livraison. Conformément à la loi sénégalaise
            sur la protection des données personnelles, vous disposez d'un droit d'accès,
            de modification et de suppression de vos données.
          </p>
          <p>
            Pour exercer ce droit, contactez-nous à : info@senharmattan.com
          </p>
        </section>

        <section>
          <h2>Cookies</h2>
          <p>
            Le site utilise des cookies techniques nécessaires à son fonctionnement
            (panier d'achat, session utilisateur). Ces cookies ne collectent aucune
            donnée personnelle à des fins publicitaires.
          </p>
        </section>
      </div>
    </div>
  );
}
