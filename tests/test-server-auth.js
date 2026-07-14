'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
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

function requestWithHost(base, pathName, host, extraHeaders = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: pathName, method: 'GET', headers: { Host: host, ...extraHeaders } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server-side auth protects app shell and entries API while public assets remain available for iOS icons', async () => {
  const app = await startTestServer();
  try {
    const appPage = await fetch(`${app.base}/`, { redirect: 'manual' });
    assert.equal(appPage.status, 302);
    assert.equal(appPage.headers.get('location'), '/login');

    const portfolio = await requestWithHost(app.base, '/', 'herbyprojects.com');
    assert.equal(portfolio.status, 200);
    assert.match(portfolio.text, /Herby Projects/);
    const portfolioApp = await requestWithHost(app.base, '/app.html', 'herbyprojects.com');
    assert.equal(portfolioApp.status, 404);

    const portfolioRedirect = await requestWithHost(app.base, '/projects/three-smiles', 'herbyprojects.com');
    assert.equal(portfolioRedirect.status, 302);
    assert.equal(portfolioRedirect.headers.location, 'https://three-smiles.herbyprojects.com');

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

test('public hostnames redirect forwarded HTTP to HTTPS and send HSTS over HTTPS', async () => {
  const app = await startTestServer();
  try {
    const insecure = await requestWithHost(app.base, '/some/path?x=1', 'herbyprojects.com', { 'X-Forwarded-Proto': 'http' });
    assert.equal(insecure.status, 301);
    assert.equal(insecure.headers.location, 'https://herbyprojects.com/some/path?x=1');

    const secure = await requestWithHost(app.base, '/', 'herbyprojects.com', { 'X-Forwarded-Proto': 'https' });
    assert.equal(secure.status, 200);
    assert.equal(secure.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally {
    await app.close();
  }
});

test('concurrent entry saves keep the data store valid and preserve every entry', async () => {
  const app = await startTestServer();
  try {
    const login = await fetch(`${app.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person: 'Charlie', passcode: 'charlie-test-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);

    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => fetch(`${app.base}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ entry: {
        person: 'Charlie',
        date: `2026-07-${String(index + 1).padStart(2, '0')}`,
        smiles: [`Concurrent smile ${index + 1}`]
      } })
    })));
    assert.deepEqual(responses.map(response => response.status), Array(12).fill(200));

    const storedText = await fs.readFile(path.join(app.temp, 'entries.json'), 'utf8');
    const stored = JSON.parse(storedText);
    assert.equal(Object.keys(stored.entries).length, 12);
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
