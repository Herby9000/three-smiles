'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PUBLIC_IP = '93.184.216.34';
const syntheticHtml = `<!doctype html><html><head><title>A useful fixture article</title></head><body>
<nav>Navigation should disappear</nav><article><h1>A useful fixture article</h1><p>By Test Writer</p>
<p>This is the first substantial paragraph in a synthetic article. It contains enough useful prose for a reader to understand the fixture without relying on publisher content.</p>
<p>This is the second substantial paragraph. It confirms that extraction preserves multiple clean blocks of readable plain text and not page furniture.</p>
<p>A final paragraph makes this deterministic body meaningful enough to pass the minimum extraction threshold in every test environment.</p>
<script>globalThis.fixtureWasUnsafe = true</script></article></body></html>`;

function htmlResponse(body = syntheticHtml, options = {}) {
  return new Response(body, {
    status: options.status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(options.headers || {}) }
  });
}

function loadService() {
  return require('../news/article-service');
}

function makeService(overrides = {}) {
  const { createArticleService } = loadService();
  return createArticleService({
    fetchImpl: async () => htmlResponse(),
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    cacheRoot: path.join(os.tmpdir(), `daily-seven-test-${crypto.randomUUID()}`),
    timeoutMs: 50,
    minTextLength: 180,
    ...overrides
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    return true;
  });
}

test('allowlist accepts exact publisher hosts and rejects URL and SSRF tricks', async () => {
  const accepted = [
    'https://www.bbc.co.uk/news/articles/fixture',
    'https://www.cbc.ca/news/fixture',
    'https://www.npr.org/fixture',
    'https://www.theguardian.com/uk-news/fixture',
    'https://arstechnica.com/fixture',
    'https://www.skysports.com/rugby-union/fixture',
    'https://saracens.com/fixture',
    'https://www.mlb.com/bluejays/news/fixture',
    'https://mlb-cuts-diamond.mlb.com/fixture',
    'https://www.sportsnet.ca/mlb/fixture'
  ];
  for (const url of accepted) assert.equal((await makeService().extract(url)).ok, true, url);

  await rejectsCode(makeService().extract('https://example.com/story'), 'host_not_allowed');
  await rejectsCode(makeService().extract('https://www.bbc.co.uk.evil.example/story'), 'host_not_allowed');
  await rejectsCode(makeService().extract('http://www.bbc.co.uk/story'), 'https_required');
  await rejectsCode(makeService().extract('https://name:secret@www.bbc.co.uk/story'), 'credentials_rejected');
  await rejectsCode(makeService().extract('https://www.bbc.co.uk:444/story'), 'port_rejected');
  await rejectsCode(makeService().extract('https://127.0.0.1/story'), 'host_not_allowed');
  await rejectsCode(makeService({ lookup: async () => [{ address: '10.2.3.4', family: 4 }] }).extract('https://www.bbc.co.uk/story'), 'unsafe_address');
  await rejectsCode(makeService({ lookup: async () => [{ address: '4000::1', family: 6 }] }).extract('https://www.bbc.co.uk/story'), 'unsafe_address');
});

test('redirect destinations are validated before the next request', async () => {
  let calls = 0;
  const service = makeService({
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    }
  });
  await rejectsCode(service.extract('https://www.bbc.co.uk/story'), 'host_not_allowed');
  assert.equal(calls, 1);
});

test('synthetic HTML becomes inert clean paragraphs without scripts or navigation', async () => {
  const result = await makeService().extract('https://www.theguardian.com/world/fixture');
  assert.equal(result.ok, true);
  assert.equal(result.article.title, 'A useful fixture article');
  assert.ok(result.article.paragraphs.length >= 3);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /<script|fixtureWasUnsafe|Navigation should disappear/i);
  assert.ok(result.article.paragraphs.every(paragraph => typeof paragraph === 'string' && !paragraph.includes('<')));
});

test('malformed publisher styles remain inert and do not pollute server logs', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = value => errors.push(String(value));
  try {
    const malformed = syntheticHtml.replace('</head>', '<style>{display:none;}</style></head>');
    const result = await makeService({ fetchImpl: async () => htmlResponse(malformed) }).extract('https://www.theguardian.com/world/malformed-style');
    assert.equal(result.ok, true);
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
  }
});

test('oversized, non-HTML, timeout, and short extraction fail honestly', async () => {
  await rejectsCode(makeService({ fetchImpl: async () => htmlResponse('', { headers: { 'content-length': '9999999' } }), maxBytes: 1000 }).extract('https://www.bbc.com/story'), 'response_too_large');
  await rejectsCode(makeService({ fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }).extract('https://www.bbc.com/story'), 'content_type_rejected');
  await rejectsCode(makeService({ fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }).extract('https://www.bbc.com/story'), 'fetch_timeout');
  await rejectsCode(makeService({ fetchImpl: async () => htmlResponse('<article><h1>Tiny</h1><p>Too short.</p></article>') }).extract('https://www.bbc.com/story'), 'extraction_too_short');
});

test('successful cache hit avoids a second fetch and uses only the injected data cache root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-seven-cache-'));
  let calls = 0;
  const service = makeService({ cacheRoot: root, fetchImpl: async () => { calls += 1; return htmlResponse(); } });
  const url = 'https://www.bbc.com/news/articles/cache-fixture';
  const first = await service.extract(url);
  const second = await service.extract(url);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.equal(calls, 1);
  const files = await fs.readdir(root);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
});
