import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, cleanTitle, cleanUrl, flagOutliers, matches, normalize, parsePrice, parseQuery } from '../src/text.js';

test('parsePrice reads Turkish store formats', () => {
  assert.equal(parsePrice('43.000 TL'), 43000);
  assert.equal(parsePrice('35.879,08 TL'), 35879.08);
  assert.equal(parsePrice('₺ 29.999'), 29999);
  assert.equal(parsePrice('30.329,66TL'), 30329.66);
  assert.equal(parsePrice('1.234.567,5 TL'), 1234567.5);
  assert.equal(parsePrice('17199.00'), 17199); // microdata
  assert.equal(parsePrice('71815.06'), 71815.06); // JSON-LD
  assert.equal(parsePrice(15549), 15549);
  assert.equal(parsePrice('6.319'), 6319); // a dot is a thousands separator
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('Tükendi'), null);
  assert.equal(parsePrice(0), null);
  assert.equal(parsePrice(null), null);
});

test('normalize folds Turkish letters, soft hyphens and letter/digit runs', () => {
  assert.equal(normalize('Gigabyte GeForce RTX­­ 4060 Ti'), 'gigabyte geforce rtx 4060 ti');
  assert.equal(normalize('RTX4060TI'), 'rtx 4060 ti');
  assert.equal(normalize('Ekran Kartı İşlemci Çekirdek'), 'ekran karti islemci cekirdek');
  assert.equal(normalize('7800X3D'), '7800 x 3 d');
});

test('matches requires every word and honours exclusions', () => {
  const q = parseQuery('rtx 4060 -ti');
  assert.deepEqual(q.include, ['rtx', '4060']);
  assert.deepEqual(q.exclude, ['ti']);
  assert.ok(matches('MSI GeForce RTX 4060 Ventus 2X Black 8G OC', q));
  assert.ok(!matches('Asus Dual Geforce Rtx 4060 Tı O8g Evo 8gb', q)); // dotless ı still excluded
  assert.ok(!matches('ASUS DUAL-RTX4060TI-O8G', q));
  assert.ok(!matches('MSI RTX 40600', q)); // whole words only
  assert.ok(matches('AMD Ryzen 7 7800X3D 4.20GHz', parseQuery('ryzen 7 7800x3d')));
  assert.ok(matches('AMD Ryzen 7 7800X3D', parseQuery('ryzen 7 7800X3D')));
});

test('classify flags accessories and full systems but not the part', () => {
  const gpu = parseQuery('rtx 4060');
  assert.equal(classify('Gigabyte RTX 4060 Eagle OC GV-N4060EAGLE OC-8GD 128 Bit GDDR6 8 GB Ekran Kartı', gpu), null);
  assert.equal(classify('Engo Lenovo Loq Rtx 4060 15.6 İnç İle Uyumlu Mat Ekran Koruyucu', gpu), 'accessory');
  assert.equal(classify('Notebook Adaptör, Şarj Aleti 130w - Dell Inspiron16 Plus7630 Geforce RTX 4060', gpu), 'accessory');
  assert.equal(classify('ACER Nitro V 15 ANV15-51 i5-13420H 8GB 512GB SSD RTX4050 15,6" FHD', gpu), 'system');
  assert.equal(classify('HP Victus 16-R1700NT i5-14450HX 32 GB 1 TB SSD RTX4060 16.1" Notebook', gpu), 'system');

  const cpu = parseQuery('ryzen 7 7800x3d');
  assert.equal(classify('AMD Ryzen 7 7800X3D 4,2 GHz 96 MB Cache AM5 İşlemci', cpu), null);
  assert.equal(classify('Xaser Raze X70 Ryzen 7 7800X3d 16Gb Ddr5 Ram 512Gb M.2 Nvme Ssd Sıvı Soğutmalı', cpu), 'system');

  // A word the user asked for is never treated as noise.
  assert.equal(classify('Logitech G915 Mekanik Klavye', parseQuery('klavye')), null);
  assert.equal(classify('Lenovo LOQ RTX 4060 Laptop', parseQuery('rtx 4060 laptop')), null);
});

test('flagOutliers marks offers far below the median of real matches', () => {
  const offers = [500, 22000, 23000, 25000, 31000].map((price) => ({ price, flag: null }));
  offers.push({ price: 900, flag: 'accessory' });
  const out = flagOutliers(offers);
  assert.equal(out[0].flag, 'outlier');
  assert.deepEqual(out.slice(1, 5).map((o) => o.flag), [null, null, null, null]);
  assert.equal(out[5].flag, 'accessory');
  assert.deepEqual(flagOutliers([]), []);
});

test('cleanUrl shortens Amazon links, including sponsored redirects', () => {
  assert.equal(
    cleanUrl('https://www.amazon.com.tr/AMD-7800X3D/dp/B0CJML6LQZ/ref=sr_1_1?keywords=x'),
    'https://www.amazon.com.tr/dp/B0CJML6LQZ',
  );
  assert.equal(
    cleanUrl('https://www.amazon.com.tr/sspa/click?ie=UTF8&url=%2FAMD-7800X3D%2Fdp%2FB0CJML6LQZ%2Fref%3Dsr_1_1_sspa'),
    'https://www.amazon.com.tr/dp/B0CJML6LQZ',
  );
  const ty = 'https://www.trendyol.com/amd/x-p-771494855?boutiqueId=61&merchantId=108281';
  assert.equal(cleanUrl(ty), ty);
});

test('cleanTitle drops ad labels', () => {
  assert.equal(cleanTitle('Sponsorlu Reklam - AMD Ryzen 7 7800X3D'), 'AMD Ryzen 7 7800X3D');
  assert.equal(cleanTitle('AMD Ryzen 7 7800X3D'), 'AMD Ryzen 7 7800X3D');
});
