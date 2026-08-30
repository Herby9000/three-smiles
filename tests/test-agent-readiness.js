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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ready-'));
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
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function visibleCharacterCount(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

test('portfolio homepage negotiates Markdown correctly and varies cache by Accept', async () => {
  const app = await startTestServer();
  try {
    const markdown = await request(app, '/', 'herbyprojects.com', { Accept: 'text/markdown, text/html;q=0.8', 'Accept-Encoding': 'gzip' });
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers['content-type'], /^text\/markdown; charset=utf-8$/);
    assert.match(markdown.headers.vary || '', /(?:^|,\s*)Accept(?:,|$)/i);
    assert.match(markdown.headers.vary || '', /(?:^|,\s*)Accept-Encoding(?:,|$)/i);
    assert.match(markdown.body, /^# Herby Projects/m);
    assert.match(markdown.body, /## Projects/);

    const html = await request(app, '/', 'herbyprojects.com', { Accept: 'text/html' });
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.match(html.headers.vary || '', /(?:^|,\s*)Accept(?:,|$)/i);
    assert.match(html.body, /<!doctype html>/i);

    const prefersHtml = await request(app, '/', 'herbyprojects.com', { Accept: 'text\/markdown;q=0.2, text\/html;q=0.9' });
    assert.match(prefersHtml.headers['content-type'], /^text\/html;/);

    const excludesHtml = await request(app, '/', 'herbyprojects.com', { Accept: '*\/*;q=1, text\/html;q=0' });
    assert.match(excludesHtml.headers['content-type'], /^text\/markdown;/, 'a specific q=0 exclusion overrides a wildcard');

    const unacceptable = await request(app, '/', 'herbyprojects.com', { Accept: 'application/pdf' });
    assert.equal(unacceptable.status, 406);
  } finally {
    await app.close();
  }
});

test('unknown portfolio paths return a recoverable Markdown 404', async () => {
  const app = await startTestServer();
  try {
    const response = await request(app, '/definitely-not-a-page-834729');
    assert.equal(response.status, 404);
    assert.match(response.headers['content-type'], /^text\/markdown; charset=utf-8$/);
    assert.match(response.body, /^# 404/m);
    assert.match(response.body, /https:\/\/herbyprojects\.com\/sitemap\.xml/);
    assert.match(response.body, /https:\/\/herbyprojects\.com\/llms\.txt/);
    assert.match(response.body, /https:\/\/herbyprojects\.com\//);
  } finally {
    await app.close();
  }
});

test('machine-readable discovery files are public and correctly formatted', async () => {
  const app = await startTestServer();
  try {
    const llms = await request(app, '/llms.txt');
    assert.equal(llms.status, 200);
    assert.match(llms.headers['content-type'], /^text\/plain; charset=utf-8$/);
    assert.match(llms.body, /^# Herby Projects/m);
    assert.match(llms.body, /## When to use Herby Projects/);
    assert.match(llms.body, /how an agent should use/i);

    const sitemap = await request(app, '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers['content-type'], /^application\/xml; charset=utf-8$/);
    assert.match(sitemap.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    for (const url of ['https://herbyprojects.com/', 'https://herbyprojects.com/about', 'https://herbyprojects.com/contact', 'https://herbyprojects.com/privacy']) {
      assert.match(sitemap.body, new RegExp(`<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>`));
    }
    assert.equal((sitemap.body.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || []).length >= 4, true);

    const robots = await request(app, '/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.body, /Sitemap: https:\/\/herbyprojects\.com\/sitemap\.xml/);
  } finally {
    await app.close();
  }
});

test('homepage exposes complete identity metadata and Organization JSON-LD', async () => {
  const app = await startTestServer();
  try {
    const response = await request(app, '/');
    assert.equal(response.status, 200);
    assert.match(response.body, /<html lang="en">/);
    assert.match(response.body, /<link rel="canonical" href="https:\/\/herbyprojects\.com\/"/);
    assert.match(response.body, /<meta property="og:type" content="website"/);
    assert.match(response.body, /<meta property="og:image" content="https:\/\/herbyprojects\.com\/assets\/herby-projects-og\.png"/);

    const match = response.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'homepage should contain JSON-LD');
    const schema = JSON.parse(match[1]);
    const organization = schema['@graph'].find(item => item['@type'] === 'Organization');
    assert.equal(organization.name, 'Herby Projects');
    assert.equal(organization.url, 'https://herbyprojects.com/');
    assert.ok(organization.contactPoint?.contactType);
    assert.ok(organization.contactPoint?.url || organization.contactPoint?.email);
    assert.equal(organization.address['@type'], 'PostalAddress');
    assert.ok(organization.address.addressLocality);
    assert.ok(organization.address.addressCountry);
  } finally {
    await app.close();
  }
});

test('trust pages are substantive, public, canonical, and Markdown-negotiable', async () => {
  const app = await startTestServer();
  try {
    for (const pathname of ['/about', '/contact', '/privacy']) {
      const html = await request(app, pathname, 'herbyprojects.com', { Accept: 'text/html' });
      assert.equal(html.status, 200, pathname);
      assert.ok(visibleCharacterCount(html.body) >= 500, `${pathname} should contain at least 500 visible characters`);
      assert.match(html.body, new RegExp(`<link rel="canonical" href="https://herbyprojects\\.com${pathname}"`));

      const markdown = await request(app, pathname, 'herbyprojects.com', { Accept: 'text/markdown' });
      assert.equal(markdown.status, 200, `${pathname} markdown`);
      assert.match(markdown.headers['content-type'], /^text\/markdown; charset=utf-8$/);
      assert.ok(markdown.body.length >= 500, `${pathname} markdown should be substantive`);
    }
  } finally {
    await app.close();
  }
});

test('unauthenticated agents get a useful Daily Seven summary instead of a login wall', async () => {
  const app = await startTestServer();
  try {
    const page = await request(app, '/news/', 'three-smiles.herbyprojects.com');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /<form[^>]+id="loginForm"/i);
    assert.match(page.body, /The Daily Seven/);
    assert.match(page.body, /public summary/i);
    assert.ok(visibleCharacterCount(page.body) >= 500);

    const markdown = await request(app, '/news/', 'three-smiles.herbyprojects.com', { Accept: 'text/markdown' });
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers['content-type'], /^text\/markdown; charset=utf-8$/);
    assert.match(markdown.body, /# The Daily Seven/);
  } finally {
    await app.close();
  }
});
