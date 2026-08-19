'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../server');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function startServer(articleService) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-seven-server-'));
  const authFile = path.join(temp, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({ sessionSecret: 'test-session-secret-with-enough-length', users: { Charlie: sha256('pass'), Daisy: sha256('other') } }));
  const server = createServer({ dataDir: temp, authFile, newsArticleService: articleService });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, temp, close: () => new Promise(resolve => server.close(resolve)) };
}

async function login(base) {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ person: 'Charlie', passcode: 'pass' }) });
  return response.headers.get('set-cookie').split(';')[0];
}

test('news navigation redirects and article API returns 401 without a session', async () => {
  const app = await startServer({ extract: async () => { throw new Error('must not run'); } });
  try {
    for (const page of ['/news/', '/news/index.html', '/news/assets/news.js', '/news/assets/news.css', '/news/assets/editorial.css', '/news/data/news.json']) {
      const response = await fetch(`${app.base}${page}`, { redirect: 'manual' });
      assert.equal(response.status, 302, page);
      assert.equal(response.headers.get('location'), `/login?next=${encodeURIComponent(page)}`);
    }
    const nested = '/news/archive/today?edition=uk&view=compact';
    const nestedResponse = await fetch(`${app.base}${nested}`, { redirect: 'manual' });
    assert.equal(nestedResponse.status, 302);
    assert.equal(nestedResponse.headers.get('location'), `/login?next=${encodeURIComponent(nested)}`);

    const api = await fetch(`${app.base}/api/news/article`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.bbc.com/story' }) });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('location'), null);
    assert.deepEqual(await api.json(), { error: 'login required' });
    const preflight = await fetch(`${app.base}/api/news/article`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 401);
    assert.equal(preflight.headers.get('location'), null);

    const publicAssets = [
      ['/news/manifest.webmanifest', 'application/manifest+json'],
      ['/news/daily-seven-icon.svg', 'image/svg+xml'],
      ['/news/daily-seven-apple-touch-icon.png', 'image/png'],
      ['/news/daily-seven-icon-192.png', 'image/png'],
      ['/news/daily-seven-icon-512.png', 'image/png']
    ];
    for (const [assetPath, contentType] of publicAssets) {
      const response = await fetch(`${app.base}${assetPath}`, { redirect: 'manual' });
      assert.equal(response.status, 200, `${assetPath} is available before authentication`);
      assert.match(response.headers.get('content-type'), new RegExp(`^${contentType.replace('+', '\\+')}`));
    }
  } finally { await app.close(); }
});

test('authenticated news shell, assets and article endpoint work without exposing cache files', async () => {
  let receivedUrl;
  const articleService = { extract: async url => { receivedUrl = url; return { ok: true, cache: 'miss', article: { title: 'Extracted', byline: 'Fixture Writer', siteName: 'BBC', excerpt: 'Excerpt', paragraphs: ['First full paragraph.', 'Second full paragraph.'] } }; } };
  const app = await startServer(articleService);
  try {
    const cookie = await login(app.base);
    for (const asset of ['/news/', '/news/assets/news.js', '/news/assets/news.css', '/news/assets/editorial.css']) {
      const response = await fetch(`${app.base}${asset}`, { headers: { cookie } });
      assert.equal(response.status, 200, asset);
    }
    const shell = await fetch(`${app.base}/news/`, { headers: { cookie } }).then(result => result.text());
    assert.match(shell, /data-filter="Editorial"/);
    assert.match(shell, /assets\/editorial\.css/);

    const dataResponse = await fetch(`${app.base}/news/data/news.json`, { headers: { cookie } });
    assert.equal(dataResponse.status, 403, 'private server does not expose repository data directories');
    const response = await fetch(`${app.base}/api/news/article`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.bbc.com/story' }) });
    assert.equal(response.status, 200);
    assert.equal(receivedUrl, 'https://www.bbc.com/story');
    assert.equal((await response.json()).article.paragraphs.length, 2);

    const cacheFile = await fetch(`${app.base}/data/news-cache/anything.json`, { headers: { cookie } });
    assert.equal(cacheFile.status, 403);
  } finally { await app.close(); }
});

test('article extraction errors return structured fallback without target URL', async () => {
  const error = Object.assign(new Error('The article did not contain enough readable text'), { code: 'extraction_too_short', status: 422 });
  const app = await startServer({ extract: async () => { throw error; } });
  try {
    const cookie = await login(app.base);
    const target = 'https://www.bbc.com/private-url-must-not-be-echoed';
    const response = await fetch(`${app.base}/api/news/article`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) });
    assert.equal(response.status, 422);
    const text = await response.text();
    assert.doesNotMatch(text, /private-url-must-not-be-echoed/);
    assert.deepEqual(JSON.parse(text), { ok: false, fallback: true, code: 'extraction_too_short', error: 'Full article unavailable; showing the feed summary.' });
  } finally { await app.close(); }
});
