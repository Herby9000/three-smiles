'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

for (const file of ['app.html', 'login.html']) {
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="assets\/apple-touch-icon\.png"/, `${file} has an iOS Home Screen PNG icon`);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="assets\/icon-192\.png"/, `${file} has a 192px PNG favicon/PWA icon`);
  assert.match(html, /<link rel="manifest" href="site\.webmanifest"/, `${file} links the web app manifest`);
}

const manifest = JSON.parse(fs.readFileSync('site.webmanifest', 'utf8'));
const icons = manifest.icons || [];
assert(icons.some(icon => icon.src === 'assets/apple-touch-icon.png' && icon.sizes === '180x180' && icon.type === 'image/png'), 'manifest includes 180px PNG icon');
assert(icons.some(icon => icon.src === 'assets/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png'), 'manifest includes 192px PNG icon');
assert(icons.some(icon => icon.src === 'assets/icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png'), 'manifest includes 512px PNG icon');

for (const [file, signature] of [
  ['assets/apple-touch-icon.png', '89504e470d0a1a0a'],
  ['assets/icon-192.png', '89504e470d0a1a0a'],
  ['assets/icon-512.png', '89504e470d0a1a0a']
]) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(0, 8).toString('hex'), signature, `${file} is a PNG`);
  assert(buffer.length > 1000, `${file} is not an empty placeholder`);
}

const newsHtml = fs.readFileSync('news/index.html', 'utf8');
assert.match(newsHtml, /<meta name="apple-mobile-web-app-title" content="Daily Seven"/);
assert.match(newsHtml, /<link rel="icon" href="daily-seven-icon\.svg" type="image\/svg\+xml"/);
assert.match(newsHtml, /<link rel="icon" type="image\/png" sizes="192x192" href="daily-seven-icon-192\.png"/);
assert.match(newsHtml, /<link rel="apple-touch-icon" sizes="180x180" href="daily-seven-apple-touch-icon\.png"/);
assert.match(newsHtml, /<link rel="manifest" href="manifest\.webmanifest"/);
assert.doesNotMatch(newsHtml, /\.\.\/assets\/icon\.svg/, 'Daily Seven does not reuse the generic Three Smiles icon');

const newsManifestUrl = new URL('https://example.test/news/manifest.webmanifest');
const newsManifest = JSON.parse(fs.readFileSync('news/manifest.webmanifest', 'utf8'));
assert.equal(newsManifest.name, 'The Daily Seven');
assert.equal(newsManifest.short_name, 'Daily Seven');
assert.equal(newsManifest.id, './');
assert.equal(new URL(newsManifest.id, newsManifestUrl).pathname, '/news/');
assert.equal(new URL(newsManifest.start_url, newsManifestUrl).pathname, '/news/');
assert.equal(new URL(newsManifest.scope, newsManifestUrl).pathname, '/news/');
assert.equal(newsManifest.theme_color, '#f3eee4');
assert.equal(newsManifest.background_color, '#f3eee4');

const expectedNewsIcons = [
  ['daily-seven-apple-touch-icon.png', '180x180', 180],
  ['daily-seven-icon-192.png', '192x192', 192],
  ['daily-seven-icon-512.png', '512x512', 512],
  ['daily-seven-icon.svg', 'any', null]
];
for (const [src, sizes, dimension] of expectedNewsIcons) {
  const icon = newsManifest.icons.find(candidate => candidate.src === src);
  assert(icon, `news manifest includes ${src}`);
  assert.equal(icon.sizes, sizes);
  assert.equal(new URL(icon.src, newsManifestUrl).pathname, `/news/${src}`);
  if (dimension) {
    const buffer = fs.readFileSync(`news/${src}`);
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${src} is a PNG`);
    assert.equal(buffer.readUInt32BE(16), dimension, `${src} has exact width`);
    assert.equal(buffer.readUInt32BE(20), dimension, `${src} has exact height`);
  }
}

const newsSvg = fs.readFileSync('news/daily-seven-icon.svg', 'utf8');
assert.notEqual(newsSvg, fs.readFileSync('assets/icon.svg', 'utf8'), 'Daily Seven has an original icon');
assert.match(newsSvg, /aria-label="Seven editorial cards and a rising sun"/);
assert.doesNotMatch(newsSvg, /<text|>\s*[Hh]\s*</, 'icon is a designed symbol, not a letter placeholder');
