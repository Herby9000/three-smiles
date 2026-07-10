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
