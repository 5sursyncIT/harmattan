import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyPaytechWebhook } from '../../server/paytech-routes.js';

const TEST_KEY = 'sandbox_api_key_xxxxx';
const TEST_SECRET = 'sandbox_api_secret_xxxxx';

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

describe('verifyPaytechWebhook', () => {
  it('refuse si credentials non configurés', () => {
    const body = { api_key_sha256: 'aaa', api_secret_sha256: 'bbb' };
    expect(verifyPaytechWebhook(body, { apiKey: '', apiSecret: '' })).toBe(false);
  });

  it('refuse si signature invalide', () => {
    const body = {
      api_key_sha256: 'aaaaa',
      api_secret_sha256: 'bbbbb',
    };
    expect(verifyPaytechWebhook(body, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(false);
  });

  it('accepte si les deux SHA256 matchent', () => {
    const body = {
      api_key_sha256: sha256(TEST_KEY),
      api_secret_sha256: sha256(TEST_SECRET),
    };
    expect(verifyPaytechWebhook(body, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(true);
  });

  it('refuse si seule la clé est correcte', () => {
    const body = {
      api_key_sha256: sha256(TEST_KEY),
      api_secret_sha256: 'mauvais',
    };
    expect(verifyPaytechWebhook(body, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(false);
  });

  it('refuse si seule la secret est correct', () => {
    const body = {
      api_key_sha256: 'mauvais',
      api_secret_sha256: sha256(TEST_SECRET),
    };
    expect(verifyPaytechWebhook(body, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(false);
  });

  it('refuse body sans champs signature', () => {
    expect(verifyPaytechWebhook({}, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(false);
    expect(verifyPaytechWebhook({ api_key_sha256: '' }, { apiKey: TEST_KEY, apiSecret: TEST_SECRET })).toBe(false);
  });
});
