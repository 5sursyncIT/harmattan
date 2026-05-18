import { describe, it, expect } from 'vitest';
import {
  buildWhatsAppOrderMessage,
  buildWhatsAppOrderUrl,
  normalizeWhatsAppPhone,
} from './whatsappOrder.js';

describe('buildWhatsAppOrderMessage', () => {
  it('cas vide : message générique', () => {
    expect(buildWhatsAppOrderMessage([])).toContain('passer une commande');
    expect(buildWhatsAppOrderMessage(null)).toContain('passer une commande');
  });

  it('un seul item : ligne + total', () => {
    const msg = buildWhatsAppOrderMessage([
      { label: 'Mon livre', quantity: 1, price_ttc: 5000 },
    ]);
    expect(msg).toContain('Mon livre × 1');
    expect(msg).toContain('5 000 FCFA'); // espace insécable étroite
    expect(msg).toContain('Total : 5 000 FCFA');
  });

  it('plusieurs items : total cumulé', () => {
    const msg = buildWhatsAppOrderMessage([
      { label: 'A', quantity: 2, price_ttc: 5000 },
      { label: 'B', quantity: 1, price_ttc: 12000 },
    ]);
    expect(msg).toContain('A × 2 — 10 000 FCFA');
    expect(msg).toContain('B × 1 — 12 000 FCFA');
    expect(msg).toContain('Total : 22 000 FCFA');
  });

  it('accepte alias title/qty/price', () => {
    const msg = buildWhatsAppOrderMessage([
      { title: 'X', qty: 3, price: 1000 },
    ]);
    expect(msg).toContain('X × 3 — 3 000 FCFA');
  });

  it('items sans label → "Article" par défaut', () => {
    const msg = buildWhatsAppOrderMessage([
      { quantity: 1, price_ttc: 1000 },
    ]);
    expect(msg).toContain('Article × 1');
  });
});

describe('normalizeWhatsAppPhone', () => {
  it('numéro 9 chiffres → préfixe 221 (Sénégal)', () => {
    expect(normalizeWhatsAppPhone('772422508')).toBe('221772422508');
  });

  it('numéro déjà avec 221 → conservé', () => {
    expect(normalizeWhatsAppPhone('221772422508')).toBe('221772422508');
  });

  it('formats avec espaces / + / parenthèses → digits only', () => {
    expect(normalizeWhatsAppPhone('+221 77 242 25 08')).toBe('221772422508');
    expect(normalizeWhatsAppPhone('(+221) 77.242.25.08')).toBe('221772422508');
  });

  it('vide / null → chaîne vide', () => {
    expect(normalizeWhatsAppPhone('')).toBe('');
    expect(normalizeWhatsAppPhone(null)).toBe('');
    expect(normalizeWhatsAppPhone(undefined)).toBe('');
  });
});

describe('buildWhatsAppOrderUrl', () => {
  it('construit une URL wa.me valide', () => {
    const url = buildWhatsAppOrderUrl('772422508', 'Bonjour');
    expect(url).toMatch(/^https:\/\/wa\.me\/221772422508\?text=/);
    expect(url).toContain(encodeURIComponent('Bonjour'));
  });

  it('encode les caractères spéciaux du message', () => {
    const url = buildWhatsAppOrderUrl('221772422508', 'Total : 5 000 FCFA');
    expect(url).toContain(encodeURIComponent('Total : 5 000 FCFA'));
  });
});
