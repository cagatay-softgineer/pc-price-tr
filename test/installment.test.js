import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallment } from '../src/text.js';

test('parseInstallment reads "Peşin Fiyatına Taksit" badges', () => {
  assert.deepEqual(parseInstallment('Peşin Fiyatına 9 Taksit'), { months: 9, cashPrice: true });
  assert.deepEqual(parseInstallment('PEŞİN FİYATINA TAKSİT İMKANI'), { months: null, cashPrice: true });
  assert.deepEqual(parseInstallment('Peşin fiyatına 3 taksit imkanı'), { months: 3, cashPrice: true });
  assert.deepEqual(parseInstallment('Peşin Fiyata Taksit'), { months: null, cashPrice: true });
});

test('parseInstallment treats vade farksız / faizsiz as cash price', () => {
  assert.deepEqual(parseInstallment('Vade farksız 6 taksit'), { months: 6, cashPrice: true });
  assert.deepEqual(parseInstallment('Faizsiz 12 Taksit'), { months: 12, cashPrice: true });
});

test('parseInstallment does not claim a cash price for a bare "N Taksit"', () => {
  assert.deepEqual(parseInstallment('9 Taksit'), { months: 9, cashPrice: false });
  assert.deepEqual(parseInstallment('9 Aya Varan Taksit'), { months: 9, cashPrice: false });
  assert.deepEqual(parseInstallment('5 taksitle ödeme ₺80.516,41'), { months: 5, cashPrice: false });
  assert.deepEqual(parseInstallment('Taksit imkanı'), { months: null, cashPrice: false });
});

test('parseInstallment takes the longest plan and returns null without one', () => {
  assert.deepEqual(parseInstallment('3 Taksit 6 Taksit 12 Taksit'), { months: 12, cashPrice: false });
  assert.equal(parseInstallment('Tek çekim'), null);
  assert.equal(parseInstallment(''), null);
  assert.equal(parseInstallment(null), null);
});
