# Activation PayTech

[paytech.sn](https://paytech.sn) est l'agrégateur de paiement utilisé en mode **checkout hosted** :
le client est redirigé vers PayTech, paie via Wave / Orange Money / Free Money / carte bancaire,
puis revient sur le site avec une URL `success` ou `cancel`. Un webhook IPN confirme côté serveur.

## 1. Créer un compte marchand

1. S'inscrire sur [paytech.sn](https://paytech.sn).
2. Vérifier l'identité (KYC) — document d'identité + RIB.
3. Une fois validé, accéder au **dashboard marchand**.

## 2. Récupérer les clés API

Dans le dashboard PayTech, section **« API »** :

- **API Key** (publique)
- **API Secret** (privée — à garder confidentielle)

Pour la **sandbox** : générer également des clés sandbox avant la mise en prod.

## 3. Configurer `.env`

```env
PAYTECH_API_KEY=<votre_api_key>
PAYTECH_API_SECRET=<votre_api_secret>
PAYTECH_ENV=test                              # ou "prod" pour production
PAYTECH_RETURN_URL=https://senharmattan.com/commande/succes
PAYTECH_CANCEL_URL=https://senharmattan.com/commande/echec
PAYTECH_IPN_URL=https://senharmattan.com/api/webhooks/paytech
```

> **Important** : l'IPN nécessite **HTTPS en production**. Le serveur actuel est en HTTP simple
> sur `38.242.229.122:3000`. Avant la mise en prod : configurer un reverse-proxy (nginx + Let's
> Encrypt) ou un domaine HTTPS direct, sinon PayTech refusera d'envoyer les webhooks.

## 4. Configurer `server/site-config.json`

```json
"admin_emails": ["commandes@senharmattan.com"],
"whatsapp_phone": "221772422508",
"payment_methods": [
  { "id": "paytech", "label": "Paiement en ligne", ..., "enabled": true },
  { "id": "virement", ..., "enabled": true }
]
```

`admin_emails` reçoit une notif à chaque commande payée. Liste vide = pas de notif.

## 5. Tester en sandbox

```bash
PAYTECH_ENV=test npm start
```

1. Ajouter un livre au panier sur la home
2. Aller sur `/panier` → `Passer la commande`
3. Remplir l'adresse → choisir « Paiement en ligne (PayTech) »
4. Soumettre → redirection vers paytech.sn (sandbox)
5. Effectuer un paiement test (carte test fournie par PayTech)
6. Retour sur `/commande/succes` — la page poll `/api/payments/status/:ref` jusqu'à confirmation
7. Vérifier en SQLite :
   ```sql
   SELECT order_ref, payment_status, external_status, external_transaction_id, invoice_ref
   FROM order_payments
   WHERE order_ref = '<ref>';
   ```
8. Vérifier qu'une facture a été créée dans Dolibarr et qu'un email a été envoyé au client + admin

## 6. Mettre en production

1. `PAYTECH_ENV=prod` + clés API prod
2. Vérifier l'URL IPN sur HTTPS
3. Faire un vrai paiement de 100 FCFA et le rembourser
4. Surveiller les logs : `journalctl -u senharmattan-shop -f | grep PAYTECH`

## 7. Endpoints exposés

| Méthode | Chemin | Auth | Description |
|--------|--------|------|-------------|
| POST | `/api/payments/paytech/init` | CSRF + cookie session | Initie un checkout pour une commande existante. Retourne `{redirect_url, token}`. |
| POST | `/api/webhooks/paytech` | HMAC SHA256 (api_key_sha256, api_secret_sha256) | Reçoit les notifications IPN. Met à jour `order_payments`, crée la facture, envoie les emails. **Idempotent**. |
| GET | `/api/payments/status/:orderId` | Public (pas sensible) | Polling client pour récupérer le statut de paiement après retour PayTech. |

## 8. Sécurité

- Le webhook vérifie `SHA256(API_KEY)` et `SHA256(API_SECRET)` avec `crypto.timingSafeEqual` ([server/paytech-routes.js](../server/paytech-routes.js))
- Rate-limit : 60 req/min sur le webhook (anti-DDOS)
- Idempotence : un paiement déjà confirmé sur le même token ne re-crée pas de facture
- Pas de PCI-DSS côté nous : checkout hosted, jamais de carte saisie sur le site

## 9. Workflow déprécié (manuel Wave/OM)

Avant PayTech, les paiements Wave / Orange Money se faisaient manuellement :
- Le client envoyait l'argent au numéro marchand
- Soumettait sa référence via `POST /api/orders/:id/payment-proof`
- Un admin validait dans `/admin/payments` qui créait la facture

**Statut actuel** :
- Le frontend masque ces options (`enabled: false` dans `site-config.json`)
- L'endpoint `/api/orders/:id/payment-proof` reste disponible 1 sprint pour compat
- Le **virement bancaire** reste en mode manuel (utile pour gros montants ou clients non équipés mobile money)

## 10. Notifications

À chaque paiement confirmé via PayTech :

- Email **client** ([server/email-service.js](../server/email-service.js) → `sendOrderConfirmationToCustomer`)
- Email **admin** (destinataires depuis `site-config.json > admin_emails`)
- WhatsApp **client** (stub no-op tant que `WHATSAPP_API_TOKEN` non défini — voir Phase 2)

## 11. Phase 2 : WhatsApp Business API (à activer plus tard)

Le service `server/whatsapp-service.js` est déjà branché. Pour activer :

1. Créer un compte Meta Business + WhatsApp Business Account (WABA)
2. Obtenir un numéro de téléphone Cloud API + token Bearer
3. Créer les templates `order_confirmation` et `shipping_update` dans Meta Business Manager
4. Remplir dans `.env` :
   ```env
   WHATSAPP_API_TOKEN=<bearer_token>
   WHATSAPP_PHONE_NUMBER_ID=<id_du_numero>
   WHATSAPP_BUSINESS_ACCOUNT_ID=<waba_id>
   WHATSAPP_API_VERSION=v20.0
   ```
5. Redémarrer le service. Les fonctions stub deviennent automatiquement actives — aucun changement de code applicatif.

## 12. Troubleshooting

**Le webhook revient toujours en 401**
→ Vérifier que `PAYTECH_API_KEY` / `PAYTECH_API_SECRET` correspondent exactement aux clés du dashboard PayTech (pas d'espace, pas de retour ligne).

**`paytech_redirect_url` est `null` au retour de POST /api/orders**
→ Soit `PAYTECH_API_KEY` n'est pas configuré (logs : `[PAYTECH] init unexpected`), soit l'API PayTech a renvoyé une erreur. Lire les logs : `grep PAYTECH /var/log/journal`.

**Paiement OK mais pas de facture créée**
→ L'appel `dolibarrApi.post('/invoices/createfromorder/:id')` a échoué. Vérifier le compte client Dolibarr existe. Le paiement reste marqué `confirmed` côté SQLite — un admin peut créer la facture manuellement depuis `/admin/payments`.

**Idempotence : double webhook → double facture ?**
→ Non. Avant traitement, on vérifie `payment_status='confirmed' AND external_transaction_id=token` → si match, retour 200 sans rien faire ([server/paytech-routes.js](../server/paytech-routes.js)).
