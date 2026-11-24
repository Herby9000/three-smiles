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
assert.match(newsHtml, /<link rel="icon" href="assets\/icons\/daily-seven\.svg\?v=2" type="image\/svg\+xml"/);
assert.match(newsHtml, /<link rel="icon" href="assets\/icons\/daily-seven-192\.png\?v=2" type="image\/png" sizes="192x192"/);
assert.match(newsHtml, /<link rel="apple-touch-icon" href="assets\/icons\/daily-seven-180\.png\?v=2" sizes="180x180"/);
assert.match(newsHtml, /<link rel="manifest" href="manifest\.webmanifest\?v=4"/);
assert.doesNotMatch(newsHtml, /\.\.\/assets\/icon\.svg/, 'Daily Seven does not reuse the generic Three Smiles icon');

const publicNewsHtml = fs.readFileSync('news/public.html', 'utf8');
assert.match(publicNewsHtml, /<link rel="icon" href="daily-seven-icon\.svg\?v=2" type="image\/svg\+xml"/);
assert.match(publicNewsHtml, /<link rel="icon" href="daily-seven-icon-192\.png\?v=2" type="image\/png" sizes="192x192"/);
assert.match(publicNewsHtml, /<link rel="apple-touch-icon" href="daily-seven-apple-touch-icon\.png\?v=2" sizes="180x180"/);
assert.match(publicNewsHtml, /<link rel="manifest" href="manifest\.webmanifest\?v=4"/);

const newsManifestUrl = new URL('https://example.test/news/manifest.webmanifest');
const newsManifest = JSON.parse(fs.readFileSync('news/manifest.webmanifest', 'utf8'));
assert.equal(newsManifest.name, 'The Daily Seven');
assert.equal(newsManifest.short_name, 'Daily Seven');
assert.equal(newsManifest.id, './');
assert.equal(newsManifest.background_color, '#ffffff');
assert.equal(newsManifest.theme_color, '#ffffff');
assert.equal(new URL(newsManifest.id, newsManifestUrl).pathname, '/news/');
assert.equal(new URL(newsManifest.start_url, newsManifestUrl).pathname, '/news/');
assert.equal(new URL(newsManifest.scope, newsManifestUrl).pathname, '/news/');
const expectedNewsIcons = [
  ['daily-seven-icon-192.png?v=2', '192x192', 192],
  ['daily-seven-icon-512.png?v=2', '512x512', 512]
];
for (const [src, sizes, dimension] of expectedNewsIcons) {
  const icon = newsManifest.icons.find(candidate => candidate.src === src);
  assert(icon, `news manifest includes ${src}`);
  assert.equal(icon.sizes, sizes);
  assert.equal(new URL(icon.src, newsManifestUrl).pathname, `/news/${src.split('?')[0]}`);
  if (dimension) {
    const buffer = fs.readFileSync(`news/${src.split('?')[0]}`);
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${src} is a PNG`);
    assert.equal(buffer.readUInt32BE(16), dimension, `${src} has exact width`);
    assert.equal(buffer.readUInt32BE(20), dimension, `${src} has exact height`);
  }
}

const newsSvg = fs.readFileSync('news/assets/icons/daily-seven.svg', 'utf8');
assert.notEqual(newsSvg, fs.readFileSync('assets/icon.svg', 'utf8'), 'Daily Seven has an original icon');
assert.match(newsSvg, /aria-labelledby="title description"/);
assert.match(newsSvg, /Baskerville-style black serif numeral 7/i);
assert.match(newsSvg, /class="numeral-seven"/);
assert.match(newsSvg, /class="oxblood-rule"/);
assert.match(newsSvg, /<rect width="512" height="512" fill="#fff"/);
assert.doesNotMatch(newsSvg, /<text|font-family|emoji/i, 'icon uses paths rather than client text or emoji');

for (const [canonical, alias] of [
  ['news/assets/icons/daily-seven.svg', 'news/daily-seven-icon.svg'],
  ['news/assets/icons/daily-seven-180.png', 'news/daily-seven-apple-touch-icon.png'],
  ['news/assets/icons/daily-seven-192.png', 'news/daily-seven-icon-192.png'],
  ['news/assets/icons/daily-seven-512.png', 'news/daily-seven-icon-512.png']
]) {
  assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(canonical), `${alias} matches its signed-in asset alias`);
}
