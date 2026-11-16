import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOffers } from '../src/search.js';
import { parseQuery } from '../src/text.js';

const site = { id: 's', name: 'S', kind: 'store' };
const q = parseQuery('rtx 4060');

test('toOffers carries the "Peşin Fiyatına Taksit" badge from the card text', () => {
  const { offers } = toOffers(
    site,
    [
      { title: 'MSI RTX 4060 Ventus', price: '17.999 TL', url: 'https://s.test/a', text: 'MSI RTX 4060 Ventus 17.999 TL Peşin Fiyatına 9 Taksit' },
      { title: 'Asus RTX 4060 Dual', price: '18.499 TL', url: 'https://s.test/b', text: 'Asus RTX 4060 Dual 18.499 TL 9 Taksit' },
      { title: 'Gigabyte RTX 4060 Eagle', price: '18.999 TL', url: 'https://s.test/c', text: 'Gigabyte RTX 4060 Eagle 18.999 TL' },
    ],
    q,
  );
  assert.deepEqual(offers[0].installment, { months: 9, cashPrice: true });
  assert.deepEqual(offers[1].installment, { months: 9, cashPrice: false });
  assert.equal(offers[2].installment, null);
});

test('toOffers drops items whose link is not http(s)', () => {
  const { offers } = toOffers(site, [{ title: 'MSI RTX 4060', price: '17.999 TL', url: 'javascript:alert(1)' }], q);
  assert.equal(offers.length, 0);
});

test('toOffers drops sold-out listings but keeps ones with unknown stock', () => {
  const { offers } = toOffers(
    site,
    [
      { title: 'MSI RTX 4060 Ventus', price: '17.999 TL', url: 'https://s.test/a', inStock: false },
      { title: 'Asus RTX 4060 Dual', price: '18.499 TL', url: 'https://s.test/b', inStock: true },
      { title: 'Gigabyte RTX 4060 Eagle', price: '18.999 TL', url: 'https://s.test/c' },
    ],
    q,
  );
  assert.deepEqual(offers.map((o) => o.url), ['https://s.test/b', 'https://s.test/c']);
});
