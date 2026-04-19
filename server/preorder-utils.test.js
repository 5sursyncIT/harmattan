import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCancellationUpdate,
  buildPreorderCancellationEmail,
  buildPreorderConfirmationEmail,
  buildPreorderReleaseEmail,
  buildReleasedStatus,
  calculatePreorderPricing,
  parseReleaseDate,
  resolvePreorderPayment,
  validatePreorderPayload,
} from './preorder-utils.js';

const paymentMethods = [
  { id: 'wave', label: 'Wave', enabled: true },
  { id: 'card', label: 'Carte bancaire', enabled: true },
];

const samplePreorder = {
  preorder_ref: 'PRE-20260402-0001',
  product_label: 'Le Sénégal & demain',
  quantity: 2,
  total_price_ttc: 21600,
  payment_method: 'wave',
  estimated_release_date: '2026-05-15',
  firstname: 'Awa',
  lastname: 'Ndiaye <script>',
  email: 'awa@example.com',
  address: '12 rue des Lilas',
  city: 'Dakar',
  country: 'Sénégal',
  status: 'preorder',
};

test('valide une précommande réussie avec tarif réduit', () => {
  const errors = validatePreorderPayload({
    product_id: '123',
    quantity: 2,
    payment_method: 'wave',
    customer: {
      firstname: 'Awa',
      lastname: 'Ndiaye',
      email: 'awa@example.com',
      phone: '771234567',
      address: '12 rue des Lilas',
      city: 'Dakar',
      country: 'Sénégal',
    },
  });

  assert.deepEqual(errors, {});

  const pricing = calculatePreorderPricing(12000, 10, 2);
  assert.equal(pricing.originalUnitPrice, 12000);
  assert.equal(pricing.preorderUnitPrice, 10800);
  assert.equal(pricing.totalPrice, 21600);

  const payment = resolvePreorderPayment('wave', [{ id: 'wave', enabled: true }]);
  assert.equal(payment.ok, true);
  assert.equal(payment.paymentStatus, 'pending');
  assert.equal(payment.preorderStatus, 'preorder');
});

test('signale un échec de paiement simulé', () => {
  const payment = resolvePreorderPayment(
    'card',
    [{ id: 'card', enabled: true }],
    { forceFailure: true }
  );

  assert.equal(payment.ok, false);
  assert.equal(payment.statusCode, 402);
  assert.match(payment.error, /paiement/i);
});

test('génère une annulation de précommande valide', () => {
  const cancellation = buildCancellationUpdate(
    {
      preorder_ref: 'PRE-20260402-0001',
      status: 'preorder',
    },
    'Client indisponible'
  );

  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.status, 'cancelled');
  assert.equal(cancellation.cancelReason, 'Client indisponible');
  assert.ok(cancellation.cancelledAt);
});

test('met à jour le statut en disponible à la date de sortie', () => {
  const nextStatus = buildReleasedStatus(
    {
      preorder_ref: samplePreorder.preorder_ref,
      status: 'preorder',
      estimated_release_date: '2026-05-15',
    },
    new Date('2026-05-15T10:00:00.000Z')
  );

  assert.equal(nextStatus, 'available');
  assert.equal(parseReleaseDate('15 mai 2026')?.getFullYear(), 2026);
});

test('refuse l’annulation d’une précommande déjà disponible', () => {
  const cancellation = buildCancellationUpdate(
    {
      preorder_ref: samplePreorder.preorder_ref,
      status: 'available',
    },
    'Trop tard'
  );

  assert.equal(cancellation.ok, false);
  assert.equal(cancellation.statusCode, 409);
  assert.match(cancellation.error, /déjà disponible/i);
});

test('construit un email de confirmation sécurisé et détaillé', () => {
  const message = buildPreorderConfirmationEmail(samplePreorder, paymentMethods);

  assert.match(message.subject, /Confirmation de précommande/);
  assert.match(message.html, /Wave/);
  assert.match(message.html, /21(?:\u202f| )600 FCFA/);
  assert.match(message.html, /15 mai 2026/i);
  assert.doesNotMatch(message.html, /<script>/i);
});

test('construit les emails d’annulation et de disponibilité', () => {
  const cancelledMessage = buildPreorderCancellationEmail(
    { ...samplePreorder, cancel_reason: 'Demande client' },
    paymentMethods
  );
  const releasedMessage = buildPreorderReleaseEmail(samplePreorder, paymentMethods);

  assert.match(cancelledMessage.subject, /Annulation/);
  assert.match(cancelledMessage.html, /Demande client/);
  assert.match(releasedMessage.subject, /disponible/i);
  assert.match(releasedMessage.html, /Bonne nouvelle/i);
});
