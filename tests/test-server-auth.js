'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../server');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function startTestServer() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'three-smiles-auth-'));
  const authFile = path.join(temp, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({
    sessionSecret: 'test-session-secret-with-enough-length',
    users: {
      Charlie: sha256('charlie-test-pass'),
      Daisy: sha256('daisy-test-pass')
    }
  }));
  const server = createServer({ dataDir: temp, authFile, allowedOrigin: 'http://127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, temp, close: () => new Promise(resolve => server.close(resolve)) };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

test('server-side auth protects app shell and entries API while public assets remain available for iOS icons', async () => {
  const app = await startTestServer();
  try {
    const appPage = await fetch(`${app.base}/`, { redirect: 'manual' });
    assert.equal(appPage.status, 302);
    assert.equal(appPage.headers.get('location'), '/login');

    const entries = await fetch(`${app.base}/api/entries`);
    assert.equal(entries.status, 401);

    for (const assetPath of ['/site.webmanifest', '/assets/apple-touch-icon.png', '/assets/icon-192.png', '/assets/icon-512.png']) {
      const asset = await fetch(`${app.base}${assetPath}`, { redirect: 'manual' });
      assert.equal(asset.status, 200, `${assetPath} should be available before login so Add to Home Screen can fetch the icon`);
    }
  } finally {
    await app.close();
  }
});

test('Charlie and Daisy can log in on different sessions and share history', async () => {
  const app = await startTestServer();
  try {
    const badLogin = await fetch(`${app.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person: 'Charlie', passcode: 'wrong' })
    });
    assert.equal(badLogin.status, 401);

    const charlieLogin = await fetch(`${app.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person: 'Charlie', passcode: 'charlie-test-pass' })
    });
    assert.equal(charlieLogin.status, 200);
    const charlieCookie = cookieFrom(charlieLogin);

    const protectedPage = await fetch(`${app.base}/`, { headers: { cookie: charlieCookie } });
    assert.equal(protectedPage.status, 200);
    assert.match(await protectedPage.text(), /What made today good/);

    const saved = await fetch(`${app.base}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: charlieCookie },
      body: JSON.stringify({
        entry: {
          person: 'Charlie',
          date: '2026-07-10',
          smiles: ['Kids laughing', 'Coffee', 'Daisy text'],
          mood: 'Grateful',
          question: 'What made you feel like a team lately?',
          answer: 'We both remembered the forms.'
        }
      })
    });
    assert.equal(saved.status, 200);

    const daisyLogin = await fetch(`${app.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person: 'Daisy', passcode: 'daisy-test-pass' })
    });
    assert.equal(daisyLogin.status, 200);
    const daisyCookie = cookieFrom(daisyLogin);

    const shared = await fetch(`${app.base}/api/entries`, { headers: { cookie: daisyCookie } });
    assert.equal(shared.status, 200);
    const data = await shared.json();
    assert.equal(data.user, 'Daisy');
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].person, 'Charlie');
    assert.equal(data.entries[0].smiles[0], 'Kids laughing');
  } finally {
    await app.close();
  }
});
