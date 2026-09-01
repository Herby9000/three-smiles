'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createServer } = require('../server');

const APP_ROUTE = '/projects/canadian-tech-challenge/';
const APP_DIR = path.join(__dirname, '..', 'public-projects', 'canadian-tech-challenge');
const DEAD_SOURCE_URLS = new Set([
  'https://generalfusion.com/technology/',
  'https://ingeniumcanada.org/channel/innovation/nortel-the-rise-and-fall-of-a-canadian-technology-giant',
  'https://pointclickcare.com/company/',
  'https://www.opentext.com/about',
  'https://www.clio.com/about/'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function startTestServer() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canadian-tech-challenge-'));
  const authFile = path.join(temp, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({
    sessionSecret: 'test-session-secret-with-enough-length',
    users: { Charlie: sha256('charlie-test-pass'), Daisy: sha256('daisy-test-pass') }
  }));
  const server = createServer({ dataDir: temp, authFile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

function request(app, pathname, host = 'herbyprojects.com', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: app.port,
      path: pathname,
      method: 'GET',
      headers: { Host: host, 'X-Forwarded-Proto': 'https', ...headers }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function login(app) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ person: 'Charlie', passcode: 'charlie-test-pass' });
    const req = http.request({ hostname: '127.0.0.1', port: app.port, path: '/api/login', method: 'POST', headers: { Host: 'herbyprojects.com', 'X-Forwarded-Proto': 'https', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume();
      res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('authenticated portfolio host serves the challenge shell and redirects to its trailing-slash URL', async () => {
  const app = await startTestServer();
  try {
    const cookie = await login(app);
    const redirect = await request(app, APP_ROUTE.slice(0, -1), 'herbyprojects.com', { cookie });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, APP_ROUTE);

    const page = await request(app, APP_ROUTE, 'herbyprojects.com', { cookie });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.match(page.text, /<title>North Star Tech Challenge — Canadian Tech Trivia<\/title>/);
    assert.match(page.text, /211 sourced questions/);
    assert.equal(page.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('all explicitly allowed nested assets resolve publicly with correct MIME types', async () => {
  const app = await startTestServer();
  const expected = new Map([
    ['assets/styles.css', /^text\/css; charset=utf-8$/],
    ['assets/core.js', /^text\/javascript; charset=utf-8$/],
    ['assets/app.js', /^text\/javascript; charset=utf-8$/],
    ['data/questions.json', /^application\/json; charset=utf-8$/],
    ['manifest.webmanifest', /^application\/manifest\+json; charset=utf-8$/],
    ['assets/icon.svg', /^image\/svg\+xml$/],
    ['assets/icon-180.png', /^image\/png$/],
    ['assets/icon-192.png', /^image\/png$/],
    ['assets/icon-512.png', /^image\/png$/]
  ]);
  try {
    const cookie = await login(app);
    const page = await request(app, APP_ROUTE, 'herbyprojects.com', { cookie });
    const [appSource, manifestSource] = await Promise.all([
      fs.readFile(path.join(APP_DIR, 'assets', 'app.js'), 'utf8'),
      fs.readFile(path.join(APP_DIR, 'manifest.webmanifest'), 'utf8')
    ]);
    const localReferences = `${page.text}\n${appSource}\n${manifestSource}`;
    for (const [relativePath, contentType] of expected) {
      assert.match(localReferences, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${relativePath} should be a relative reference`);
      const resolved = new URL(relativePath, `https://herbyprojects.com${APP_ROUTE}`).pathname;
      const response = await request(app, resolved, 'herbyprojects.com', { cookie });
      assert.equal(response.status, 200, relativePath);
      assert.match(response.headers['content-type'], contentType, relativePath);
      if (!relativePath.endsWith('.webmanifest')) assert.equal(response.headers['cache-control'], 'public, max-age=3600', relativePath);
    }
  } finally {
    await app.close();
  }
});

test('question data has the exact expanded category counts and excludes previously dead sources', async () => {
  const questions = JSON.parse(await fs.readFile(path.join(APP_DIR, 'data', 'questions.json'), 'utf8'));
  assert.equal(questions.length, 211);
  const counts = questions.reduce((result, question) => {
    result[question.category] = (result[question.category] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, {
    'AI & Data': 61,
    'Fintech & Crypto': 56,
    'SaaS & Enterprise': 12,
    'Consumer & Commerce': 12,
    'Deep Tech & Climate': 12,
    'Builders & Breakthroughs': 12,
    'Frontier & Defence': 46
  });
  for (const question of questions) assert.equal(DEAD_SOURCE_URLS.has(question.sourceUrl), false, question.id);
});

test('challenge allowlist does not expose traversal, unknown, dot, or test paths', async () => {
  const app = await startTestServer();
  try {
    const cookie = await login(app);
    for (const pathname of [
      `${APP_ROUTE}unknown.txt`,
      `${APP_ROUTE}tests/test_runtime.js`,
      `${APP_ROUTE}.git/config`,
      `${APP_ROUTE}data/other.json`,
      `${APP_ROUTE}%2e%2e%2f%2e%2e%2fserver.js`,
      `${APP_ROUTE}assets/%2e%2e/%2e%2e/server.js`
    ]) {
      const response = await request(app, pathname, 'herbyprojects.com', { cookie });
      assert.equal(response.status, 404, pathname);
      assert.doesNotMatch(response.text, /createServer|North Star runtime tests/);
    }
  } finally {
    await app.close();
  }
});

test('challenge remains unavailable without authentication on canonical and private hosts', async () => {
  const app = await startTestServer();
  try {
    for (const host of ['herbyprojects.com', 'three-smiles.herbyprojects.com']) {
      for (const pathname of [APP_ROUTE, `${APP_ROUTE}assets/styles.css`, `${APP_ROUTE}data/questions.json`]) {
        const response = await request(app, pathname, host);
        assert.equal(response.status, 302, `${host}${pathname}`);
        assert.equal(response.headers.location, `/login?next=${encodeURIComponent(pathname)}`);
      }
    }
  } finally {
    await app.close();
  }
});

test('portfolio card, Markdown listing, and sitemap advertise the canonical challenge URL', async () => {
  const [html, markdown, sitemap] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'portfolio.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'portfolio.md'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'sitemap.xml'), 'utf8')
  ]);
  assert.match(html, /<h3>North Star Tech Challenge<\/h3>/);
  assert.match(html, /href="\/projects\/canadian-tech-challenge\/"/);
  assert.match(markdown, /\[North Star Tech Challenge\]\(https:\/\/herbyprojects\.com\/projects\/canadian-tech-challenge\/\)/);
  assert.match(sitemap, /<loc>https:\/\/herbyprojects\.com\/projects\/canadian-tech-challenge\/<\/loc>/);
});
