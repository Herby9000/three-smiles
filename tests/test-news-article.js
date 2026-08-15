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

const imageHtml = `<!doctype html><html><head><title>Images in order</title></head><body><article>
<h1>Images in order</h1>
<p>The opening paragraph is deliberately substantial and appears before the first publisher photograph in this deterministic extraction fixture.</p>
<figure><img src="/media/market.jpg" alt="  Market &amp; shoppers  " width="1200" height="800"><figcaption> Market activity <em>this morning</em> </figcaption></figure>
<p>The middle paragraph is also long enough to remain in the extracted article and establish the expected document ordering.</p>
<img src="data:image/gif;base64,AAAA" alt="unsafe">
<img src="/pixel.gif" width="1" height="1" alt="tracker">
<img src="/media/market.jpg" alt="duplicate">
<img src="data:image/gif;base64,AAAA" data-lazy-src="//media.guim.co.uk/lazy/economy.jpg" alt="  Lazy economy image  " title=" Publisher title ">
<p>The closing paragraph provides enough additional prose to satisfy the extraction threshold after all unsafe page material is discarded.</p>
</article></body></html>`;

const highResolutionHtml = `<!doctype html><html><head>
<title>High resolution images</title>
<meta content="https://user:secret@images.example.test/unsafe.jpg" property="og:image">
<meta property="og:image" content="/media/too-narrow.jpg"><meta content="959" property="og:image:width"><meta property="og:image:height" content="540">
<meta property="og:image" content="/media/too-short.jpg"><meta property="og:image:width" content="960"><meta property="og:image:height" content="539">
<meta content="/media/lead-large.jpg?label=Market&amp;day=Today" property="og:image">
<meta content="1200" property="og:image:width"><meta content="630" property="og:image:height"><meta content=" Markets &amp; shoppers " property="og:image:alt">
<meta name="twitter:image:height" content="600"><meta content="/media/twitter.jpg" name="twitter:image"><meta content="1000" name="twitter:image:width">
<meta property="og:image" content="/media/lead-large.jpg?label=Market&amp;day=Today"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
</head><body><article><h1>High resolution images</h1>
<p>The opening paragraph contains enough substantial fixture prose to make this high resolution metadata article readable and deterministic.</p>
<img src="/media/fallback.jpg" srcset="/media/inline-960.jpg 960w, /media/inline-1600.jpg 1600w" width="1200" height="800" alt="Inline large">
<img src="/media/inline-low.jpg" width="959" height="540" alt="Inline too narrow">
<img src="/media/inline-unknown.jpg" alt="Inline dimensions unknown">
<p>The closing paragraph contains enough additional fixture prose to satisfy extraction while preserving ordered safe article blocks.</p>
</article></body></html>`;

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

test('Readability content preserves ordered clean paragraphs and unique safe publisher images', async () => {
  const result = await makeService({ fetchImpl: async () => htmlResponse(imageHtml) })
    .extract('https://www.theguardian.com/business/economics/fixture');
  assert.deepEqual(result.article.blocks.map(block => block.type), ['paragraph', 'image', 'paragraph', 'image', 'paragraph']);
  assert.deepEqual(result.article.blocks.filter(block => block.type === 'image'), [
    { type: 'image', url: 'https://www.theguardian.com/media/market.jpg', alt: 'Market & shoppers', width: 1200, height: 800, caption: 'Market activity this morning' },
    { type: 'image', url: 'https://media.guim.co.uk/lazy/economy.jpg', alt: 'Lazy economy image', title: 'Publisher title' }
  ]);
  assert.deepEqual(result.article.paragraphs, result.article.blocks.filter(block => block.type === 'paragraph').map(block => block.text));
  assert.doesNotMatch(JSON.stringify(result.article.blocks.filter(block => block.type === 'image')), /data:image|pixel\.gif|<em>|duplicate|unsafe|tracker/i);
});

test('publisher metadata selects the largest qualifying safe lead and inline images enforce declared dimensions', async () => {
  const result = await makeService({ fetchImpl: async () => htmlResponse(highResolutionHtml) })
    .extract('https://www.theguardian.com/business/economics/high-resolution');
  assert.deepEqual(result.article.leadImage, {
    url: 'https://www.theguardian.com/media/lead-large.jpg?label=Market&day=Today',
    width: 1200,
    height: 630,
    alt: 'Markets & shoppers'
  });
  assert.deepEqual(result.article.blocks.filter(block => block.type === 'image'), [
    { type: 'image', url: 'https://www.theguardian.com/media/inline-1600.jpg', width: 1200, height: 800, alt: 'Inline large' },
    { type: 'image', url: 'https://www.theguardian.com/media/inline-unknown.jpg', alt: 'Inline dimensions unknown' }
  ]);
  assert.doesNotMatch(JSON.stringify(result.article), /too-narrow|too-short|unsafe|inline-low|fallback/);
});

test('lead metadata accepts exact minimum, handles attribute order and entities, deduplicates, and rejects SVG', async () => {
  const html = highResolutionHtml.replace(/<meta[\s\S]*?<\/head>/, `<meta content="540" property="og:image:height">
    <meta content="/media/exact.jpg?one=1&amp;two=2" property="og:image"><meta content="960" property="og:image:width">
    <meta content="/media/exact.jpg?one=1&amp;two=2" name="twitter:image"><meta content="960" name="twitter:image:width"><meta content="540" name="twitter:image:height">
    <meta property="og:image" content="https://images.example.test/vector.svg"><meta property="og:image:width" content="2000"><meta property="og:image:height" content="1200"></head>`);
  const result = await makeService({ fetchImpl: async () => htmlResponse(html) })
    .extract('https://www.bbc.com/news/articles/metadata-order');
  assert.deepEqual(result.article.leadImage, {
    url: 'https://www.bbc.com/media/exact.jpg?one=1&two=2', width: 960, height: 540, alt: ''
  });
});

test('image URLs resolve against the final article URL and reject unsafe URL forms', async () => {
  const images = [
    '<img src="../photos/relative.jpg" alt="relative">',
    '<img src="//cdn.example.test/protocol.jpg" alt="protocol">',
    '<img src="https://user:pass@cdn.example.test/credential.jpg" alt="credentials">',
    '<img src="https://cdn.example.test:8443/port.jpg" alt="port">',
    '<img src="javascript:alert(1)" alt="script">',
    '<img src="file:///tmp/private.jpg" alt="file">',
    '<img src="blob:https://cdn.example.test/id" alt="blob">',
    '<img srcset="http://cdn.example.test/bad.jpg 1x, https://cdn.example.test/good.jpg 2x" alt="srcset">'
  ].join('');
  const body = syntheticHtml.replace('<script>', `${images}<script>`);
  const service = makeService({
    fetchImpl: async url => url.includes('/start')
      ? new Response(null, { status: 302, headers: { location: '/section/final/article.html' } })
      : htmlResponse(body)
  });
  const result = await service.extract('https://www.bbc.com/start');
  assert.deepEqual(result.article.blocks.filter(block => block.type === 'image').map(block => block.url), [
    'https://www.bbc.com/section/photos/relative.jpg',
    'https://cdn.example.test/protocol.jpg',
    'https://cdn.example.test/good.jpg'
  ]);
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

test('old paragraph-only cache entries are not served as current extraction hits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-seven-old-cache-'));
  const url = 'https://www.bbc.com/news/articles/old-cache';
  const key = crypto.createHash('sha256').update(url).digest('hex');
  await fs.writeFile(path.join(root, `${key}.json`), JSON.stringify({
    fetchedAt: Date.now(),
    article: { title: 'Old cached title', paragraphs: ['Old paragraph one long enough to pass.', 'Old paragraph two long enough to pass.'] }
  }));
  let calls = 0;
  const result = await makeService({ cacheRoot: root, fetchImpl: async () => { calls += 1; return htmlResponse(); } }).extract(url);
  assert.equal(result.cache, 'miss');
  assert.equal(calls, 1);
  assert.ok(Array.isArray(result.article.blocks));
  assert.notEqual(result.article.title, 'Old cached title');
});

test('previous structured cache schema without high-resolution lead metadata is invalidated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-seven-v2-cache-'));
  const url = 'https://www.bbc.com/news/articles/v2-cache';
  const key = crypto.createHash('sha256').update(url).digest('hex');
  await fs.writeFile(path.join(root, `${key}.json`), JSON.stringify({
    version: 2,
    fetchedAt: Date.now(),
    article: {
      title: 'Previous structured cache',
      paragraphs: ['Old paragraph one long enough to pass.', 'Old paragraph two long enough to pass.'],
      blocks: [{ type: 'paragraph', text: 'Old paragraph one long enough to pass.' }, { type: 'paragraph', text: 'Old paragraph two long enough to pass.' }]
    }
  }));
  let calls = 0;
  const result = await makeService({ cacheRoot: root, fetchImpl: async () => { calls += 1; return htmlResponse(highResolutionHtml); } }).extract(url);
  assert.equal(result.cache, 'miss');
  assert.equal(calls, 1);
  assert.equal(result.article.leadImage.width, 1200);
});
