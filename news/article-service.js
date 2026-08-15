'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const CACHE_FORMAT_VERSION = 2;

const ALLOWED_HOSTS = new Set([
  'bbc.com', 'www.bbc.com', 'bbc.co.uk', 'www.bbc.co.uk', 'news.bbc.co.uk',
  'cbc.ca', 'www.cbc.ca',
  'npr.org', 'www.npr.org',
  'theguardian.com', 'www.theguardian.com',
  'arstechnica.com', 'www.arstechnica.com',
  'skysports.com', 'www.skysports.com',
  'saracens.com', 'www.saracens.com',
  'mlb.com', 'www.mlb.com', 'mlb-cuts-diamond.mlb.com', 'bluejays.com', 'www.bluejays.com', 'toronto.bluejays.mlb.com',
  'sportsnet.ca', 'www.sportsnet.ca'
]);

const DEFAULTS = {
  timeoutMs: 8_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 4,
  cacheTtlMs: 12 * 60 * 60 * 1000,
  maxCacheEntries: 100,
  maxImages: 20,
  minTextLength: 300
};

class NewsArticleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'NewsArticleError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new NewsArticleError(code, message, status);
}

function parseIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets;
}

function isUnsafeAddress(rawAddress) {
  const address = String(rawAddress).toLowerCase().split('%')[0];
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = parseIpv4(address);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const first = Number.parseInt(address.split(':')[0] || '0', 16);
    const globallyRoutable = first >= 0x2000 && first <= 0x3fff;
    return !globallyRoutable || address.startsWith('2001:0:') || address.startsWith('2001:2:') ||
      address.startsWith('2001:10:') || address.startsWith('2001:20:') ||
      address.startsWith('2001:db8:') || address.startsWith('2002:');
  }
  return true;
}

function parseTarget(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    fail('invalid_url', 'A valid article URL is required.');
  }
  if (target.protocol !== 'https:') fail('https_required', 'Only HTTPS articles are supported.');
  if (target.username || target.password) fail('credentials_rejected', 'URL credentials are not allowed.');
  if (target.port && target.port !== '443') fail('port_rejected', 'Non-standard ports are not allowed.');
  const hostname = target.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) fail('host_not_allowed', 'This publisher is not supported.');
  return target;
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeImageUrl(value, articleUrl) {
  try {
    const rawUrl = plainText(value);
    if (!rawUrl) return '';
    const url = new URL(rawUrl, articleUrl);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
    return url.href;
  } catch {
    return '';
  }
}

function srcsetCandidates(value) {
  const withoutDataUrls = String(value || '').replace(/data:[^,\s]+,[^\s,]+(?:\s+\d+(?:\.\d+)?[wx])?/gi, '');
  return plainText(withoutDataUrls).split(',').map((candidate, index) => {
    const [url, descriptor = ''] = candidate.trim().split(/\s+/);
    const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/);
    return { url, score: match ? Number(match[1]) : 0, index };
  }).filter(candidate => candidate.url).sort((a, b) => b.score - a.score || a.index - b.index);
}

function imageSource(node, articleUrl) {
  const candidates = ['data-src', 'data-lazy-src', 'data-original']
    .map(attribute => node.getAttribute(attribute))
    .filter(Boolean);
  candidates.push(...srcsetCandidates(node.getAttribute('srcset')).map(candidate => candidate.url));
  const src = node.getAttribute('src');
  if (src) candidates.push(src);
  for (const candidate of candidates) {
    const url = safeImageUrl(candidate, articleUrl);
    if (url) return url;
  }
  return '';
}

function isDeclaredTinyImage(node) {
  const width = Number.parseFloat(node.getAttribute('width'));
  const height = Number.parseFloat(node.getAttribute('height'));
  return (Number.isFinite(width) && width > 0 && width <= 32) ||
    (Number.isFinite(height) && height > 0 && height <= 32);
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) fail('response_too_large', 'The article response was too large.', 413);
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      fail('response_too_large', 'The article response was too large.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function sanitizeExtraction(html, articleUrl, minTextLength, maxImages) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: articleUrl, virtualConsole });
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed?.content) fail('extraction_failed', 'No readable article body was found.', 422);

  const articleDom = new JSDOM(`<main>${parsed.content}</main>`, { virtualConsole });
  const blocks = [];
  const paragraphs = [];
  const imageUrls = new Set();
  let imageCount = 0;
  for (const node of articleDom.window.document.querySelectorAll('p, img')) {
    if (node.localName === 'p') {
      if (node.closest('figcaption')) continue;
      const text = plainText(node.textContent);
      if (text.length < 30 || paragraphs.length >= 250) continue;
      paragraphs.push(text);
      blocks.push({ type: 'paragraph', text });
      continue;
    }
    if (imageCount >= maxImages || isDeclaredTinyImage(node)) continue;
    const url = imageSource(node, articleUrl);
    if (!url || imageUrls.has(url)) continue;
    const block = { type: 'image', url, alt: plainText(node.getAttribute('alt')) };
    const figure = node.closest('figure');
    const caption = plainText(figure?.querySelector('figcaption')?.textContent);
    const title = plainText(node.getAttribute('title'));
    if (caption) block.caption = caption;
    if (title) block.title = title;
    imageUrls.add(url);
    imageCount += 1;
    blocks.push(block);
  }
  const bodyLength = paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
  if (paragraphs.length < 2 || bodyLength < minTextLength) {
    fail('extraction_too_short', 'The article did not contain enough readable text.', 422);
  }

  return {
    title: plainText(parsed.title),
    byline: plainText(parsed.byline),
    siteName: plainText(parsed.siteName),
    excerpt: plainText(parsed.excerpt),
    paragraphs,
    blocks
  };
}

function createArticleService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookup = options.lookup || dns.lookup;
  const cacheRoot = options.cacheRoot || path.join(__dirname, '..', 'data', 'news-cache');
  const now = options.now || (() => Date.now());
  const config = { ...DEFAULTS, ...options };

  async function validate(target) {
    const addresses = await lookup(target.hostname, { all: true, verbatim: true });
    const records = Array.isArray(addresses) ? addresses : [addresses];
    if (!records.length || records.some(record => isUnsafeAddress(record.address))) {
      fail('unsafe_address', 'The publisher resolved to an unsafe network address.');
    }
  }

  function cachePath(target) {
    const key = crypto.createHash('sha256').update(target.href).digest('hex');
    return path.join(cacheRoot, `${key}.json`);
  }

  async function readCache(target) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath(target), 'utf8'));
      const blocks = cached.article?.blocks;
      const validBlocks = Array.isArray(blocks) && blocks.length >= 2 && blocks.every(block =>
        (block?.type === 'paragraph' && typeof block.text === 'string') ||
        (block?.type === 'image' && safeImageUrl(block.url) === block.url && typeof block.alt === 'string' &&
          (block.caption === undefined || typeof block.caption === 'string') &&
          (block.title === undefined || typeof block.title === 'string')));
      if (cached.version === CACHE_FORMAT_VERSION && validBlocks &&
          cached.fetchedAt + config.cacheTtlMs > now() && cached.article.paragraphs?.length >= 2) return cached.article;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return null;
  }

  async function pruneCache() {
    const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
    const files = await Promise.all(entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map(async entry => ({
      name: entry.name,
      stat: await fs.stat(path.join(cacheRoot, entry.name))
    })));
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    await Promise.all(files.slice(config.maxCacheEntries).map(file => fs.unlink(path.join(cacheRoot, file.name)).catch(() => {})));
  }

  async function writeCache(target, article) {
    await fs.mkdir(cacheRoot, { recursive: true });
    const destination = cachePath(target);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: CACHE_FORMAT_VERSION, fetchedAt: now(), article }), { mode: 0o600 });
    await fs.rename(temporary, destination);
    await pruneCache();
  }

  async function fetchHtml(initialTarget) {
    let target = initialTarget;
    for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
      await validate(target);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(target.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'user-agent': 'ThreeSmilesDailySeven/1.0 (private readability reader)'
          }
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) fail('redirect_invalid', 'The publisher returned an invalid redirect.', 502);
          if (redirects === config.maxRedirects) fail('too_many_redirects', 'The publisher redirected too many times.', 502);
          target = parseTarget(new URL(location, target).href);
          continue;
        }
        if (!response.ok) fail('publisher_unavailable', 'The publisher did not return an available article.', 502);
        const contentType = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
        if (!['text/html', 'application/xhtml+xml'].includes(contentType)) {
          fail('content_type_rejected', 'The publisher response was not HTML.', 415);
        }
        return { html: await readResponseBody(response, config.maxBytes), finalUrl: target.href };
      } catch (error) {
        if (error.name === 'AbortError' || controller.signal.aborted) fail('fetch_timeout', 'The publisher request timed out.', 504);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    fail('too_many_redirects', 'The publisher redirected too many times.', 502);
  }

  async function extract(rawUrl) {
    const target = parseTarget(rawUrl);
    const cached = await readCache(target);
    if (cached) return { ok: true, cache: 'hit', article: cached };
    const { html, finalUrl } = await fetchHtml(target);
    const article = sanitizeExtraction(html, finalUrl, config.minTextLength, config.maxImages);
    await writeCache(target, article);
    return { ok: true, cache: 'miss', article };
  }

  return { extract };
}

module.exports = { ALLOWED_HOSTS, NewsArticleError, createArticleService, isUnsafeAddress };
