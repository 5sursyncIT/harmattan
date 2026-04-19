import './LegalPages.css';

export default function CGVPage() {
  return (
    <div className="legal-page">
      <div className="container">
        <h1>Conditions Générales de Vente</h1>
        <p className="legal-date">Dernière mise à jour : Mars 2026</p>

        <section>
          <h2>Article 1 - Objet</h2>
          <p>
            Les présentes conditions générales de vente régissent les relations contractuelles
            entre Sen Harmattan, dont le siège social est situé au 10 Rue Tolbiac, Dakar, Sénégal,
            et toute personne effectuant un achat via le site senharmattan.com (ci-après « le Client »).
          </p>
        </section>

        <section>
          <h2>Article 2 - Produits</h2>
          <p>
            Les produits proposés à la vente sont des ouvrages (livres) neufs. Chaque produit
            est présenté avec une description incluant ses caractéristiques essentielles
            (titre, auteur, ISBN, prix). Les photographies illustrant les produits n'entrent
            pas dans le champ contractuel.
          </p>
        </section>

        <section>
          <h2>Article 3 - Prix</h2>
          <p>
            Les prix sont indiqués en Francs CFA (XOF), toutes taxes comprises.
            Sen Harmattan se réserve le droit de modifier ses prix à tout moment.
            Les produits sont facturés sur la base des tarifs en vigueur au moment
            de la validation de la commande.
          </p>
        </section>

        <section>
          <h2>Article 4 - Commandes</h2>
          <p>
            Le Client passe commande sur le site senharmattan.com. La validation de la commande
            implique l'acceptation des présentes CGV. Une confirmation de commande est envoyée
            par email. Sen Harmattan se réserve le droit d'annuler toute commande en cas
            d'indisponibilité du produit ou de problème de paiement.
          </p>
        </section>

        <section>
          <h2>Article 5 - Paiement</h2>
          <p>Le paiement peut être effectué par :</p>
          <ul>
            <li>Orange Money</li>
            <li>Wave</li>
            <li>Carte bancaire (Visa, Mastercard)</li>
            <li>Virement bancaire</li>
          </ul>
          <p>
            La commande est traitée après réception et validation du paiement.
          </p>
        </section>

        <section>
          <h2>Article 6 - Livraison</h2>
          <p>
            Les livraisons sont effectuées à l'adresse indiquée par le Client lors de la commande.
            Les délais de livraison sont indicatifs. Pour Dakar, la livraison est généralement
            effectuée sous 24 à 48 heures. Pour les régions et l'international, les délais
            varient selon la destination.
          </p>
        </section>

        <section>
          <h2>Article 7 - Droit de rétractation</h2>
          <p>
            Le Client dispose d'un délai de 14 jours à compter de la réception de sa commande
            pour exercer son droit de rétractation, sans avoir à justifier de motif.
            Les produits doivent être retournés dans leur état d'origine, non ouverts et non endommagés.
            Les frais de retour sont à la charge du Client.
          </p>
        </section>

        <section>
          <h2>Article 8 - Réclamations</h2>
          <p>
            Pour toute réclamation, le Client peut contacter Sen Harmattan par email à
            info@senharmattan.com ou par téléphone au +221 33 821 10 96.
          </p>
        </section>

        <section>
          <h2>Article 9 - Loi applicable</h2>
          <p>
            Les présentes CGV sont soumises au droit sénégalais. En cas de litige,
            les tribunaux de Dakar seront seuls compétents.
          </p>
        </section>
      </div>
    </div>
  );
}
