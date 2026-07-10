#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.json');
const PUBLIC_DIR = __dirname;
const MAX_BODY = 64 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers
  });
  res.end(body);
}

function hashCircle(circleId) {
  return crypto.createHash('sha256').update(String(circleId || 'default')).digest('hex').slice(0, 32);
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('entry is required');
  const person = String(entry.person || '').trim();
  const date = String(entry.date || '').trim();
  if (!['Daisy', 'Charlie'].includes(person)) throw new Error('person must be Daisy or Charlie');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const smiles = Array.isArray(entry.smiles) ? entry.smiles.slice(0, 3).map(v => String(v || '').trim().slice(0, 360)) : [];
  if (!smiles.some(Boolean)) throw new Error('at least one smile is required');
  return {
    person,
    date,
    smiles,
    mood: String(entry.mood || '').trim().slice(0, 40),
    question: String(entry.question || '').trim().slice(0, 300),
    answer: String(entry.answer || '').trim().slice(0, 520),
    savedAt: entry.savedAt || new Date().toISOString(),
    syncedAt: new Date().toISOString()
  };
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { circles: {} };
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

async function parseBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'three-smiles-backend' });
  }

  if (url.pathname === '/api/entries' && req.method === 'GET') {
    const circle = hashCircle(url.searchParams.get('circleId') || 'daisy-charlie');
    const store = await readStore();
    const entries = Object.values(store.circles[circle]?.entries || {}).sort((a, b) => (b.date + b.person).localeCompare(a.date + a.person));
    return send(res, 200, { entries });
  }

  if (url.pathname === '/api/entries' && req.method === 'POST') {
    const payload = await parseBody(req);
    const circle = hashCircle(payload.circleId || 'daisy-charlie');
    const entry = cleanEntry(payload.entry);
    const store = await readStore();
    store.circles[circle] ||= { entries: {} };
    store.circles[circle].entries[`${entry.date}::${entry.person}`] = entry;
    await writeStore(store);
    return send(res, 200, { ok: true, entry });
  }

  return send(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`)) {
    return send(res, 403, 'Forbidden');
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not found');
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    return send(res, 400, { error: error.message || 'bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`Three Smiles backend listening on http://127.0.0.1:${PORT}`);
});
