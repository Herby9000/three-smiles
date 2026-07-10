#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_AUTH_FILE = process.env.AUTH_FILE || path.join(DEFAULT_DATA_DIR, 'auth.json');
const PUBLIC_DIR = __dirname;
const MAX_BODY = 64 * 1024;
const SESSION_COOKIE = 'three_smiles_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function loadAuth(authFile) {
  const fromEnv = {
    sessionSecret: process.env.SESSION_SECRET,
    users: {
      Charlie: process.env.CHARLIE_PASSCODE_HASH,
      Daisy: process.env.DAISY_PASSCODE_HASH
    }
  };
  if (fromEnv.sessionSecret && fromEnv.users.Charlie && fromEnv.users.Daisy) return fromEnv;

  try {
    const config = JSON.parse(await fs.readFile(authFile, 'utf8'));
    if (!config.sessionSecret || !config.users?.Charlie || !config.users?.Daisy) throw new Error('auth config must include sessionSecret and users.Charlie/users.Daisy hashes');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing auth config at ${authFile}. Create it with sessionSecret plus SHA-256 passcode hashes for Charlie and Daisy.`);
    }
    throw error;
  }
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSession(person, secret) {
  const payload = JSON.stringify({ person, exp: Date.now() + SESSION_TTL_MS, nonce: crypto.randomBytes(12).toString('base64url') });
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey) out[rawKey] = rest.join('=');
  }
  return out;
}

function readSession(req, auth) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!timingSafeEqual(signature, sign(body, auth.sessionSecret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!auth.users[payload.person] || payload.exp < Date.now()) return null;
    return { person: payload.person };
  } catch {
    return null;
  }
}

function sessionCookie(token, req) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || req.socket.encrypted;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end('Found');
}

function cleanEntry(entry, session) {
  if (!entry || typeof entry !== 'object') throw new Error('entry is required');
  const person = String(entry.person || session.person || '').trim();
  const date = String(entry.date || '').trim();
  if (!['Daisy', 'Charlie'].includes(person)) throw new Error('person must be Daisy or Charlie');
  if (person !== session.person) throw new Error('you can only save your own entries');
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

async function readStore(dataFile) {
  try {
    return JSON.parse(await fs.readFile(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: {} };
    throw error;
  }
}

async function writeStore(dataDir, dataFile, store) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${dataFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, dataFile);
}

async function parseBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function corsHeaders(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!allowedOrigin || !origin) return {};
  if (allowedOrigin === '*' || allowedOrigin.split(',').map(v => v.trim()).includes(origin)) {
    return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  }
  return {};
}

function createServer(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const dataFile = options.dataFile || path.join(dataDir, 'entries.json');
  const authFile = options.authFile || DEFAULT_AUTH_FILE;
  const allowedOrigin = options.allowedOrigin ?? process.env.ALLOWED_ORIGIN;
  let authPromise;
  const getAuth = () => authPromise ||= loadAuth(authFile);

  async function handleLogin(req, res) {
    const auth = await getAuth();
    const payload = await parseBody(req);
    const person = String(payload.person || '').trim();
    const expected = auth.users[person];
    if (!expected || !timingSafeEqual(sha256(payload.passcode || ''), expected)) {
      return send(res, 401, { error: 'invalid login' }, corsHeaders(req, allowedOrigin));
    }
    const token = makeSession(person, auth.sessionSecret);
    return send(res, 200, { ok: true, person }, { ...corsHeaders(req, allowedOrigin), 'set-cookie': sessionCookie(token, req) });
  }

  async function requireSession(req, res) {
    const auth = await getAuth();
    const session = readSession(req, auth);
    if (!session) {
      if (req.url.startsWith('/api/')) send(res, 401, { error: 'login required' }, corsHeaders(req, allowedOrigin));
      else redirect(res, '/login');
      return null;
    }
    return session;
  }

  async function handleApi(req, res, url) {
    if (req.method === 'OPTIONS') return send(res, 204, '', { ...corsHeaders(req, allowedOrigin), 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-credentials': 'true' });
    if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(), ...corsHeaders(req, allowedOrigin) });
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, service: 'three-smiles-backend' });

    const session = await requireSession(req, res);
    if (!session) return;

    if (url.pathname === '/api/me' && req.method === 'GET') return send(res, 200, { person: session.person }, corsHeaders(req, allowedOrigin));

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const store = await readStore(dataFile);
      const entries = Object.values(store.entries || {}).sort((a, b) => (b.date + b.person).localeCompare(a.date + a.person));
      return send(res, 200, { user: session.person, entries }, corsHeaders(req, allowedOrigin));
    }

    if (url.pathname === '/api/entries' && req.method === 'POST') {
      const payload = await parseBody(req);
      const entry = cleanEntry(payload.entry, session);
      const store = await readStore(dataFile);
      store.entries ||= {};
      store.entries[`${entry.date}::${entry.person}`] = entry;
      await writeStore(dataDir, dataFile, store);
      return send(res, 200, { ok: true, entry }, corsHeaders(req, allowedOrigin));
    }

    return send(res, 404, { error: 'not found' }, corsHeaders(req, allowedOrigin));
  }

  async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/login') pathname = '/login.html';
    const publicAssetPaths = new Set([
      '/login.html',
      '/site.webmanifest',
      '/sw.js',
      '/sw-v2.js',
      '/assets/icon.svg',
      '/assets/apple-touch-icon.png',
      '/assets/icon-192.png',
      '/assets/icon-512.png'
    ]);
    const isLoginAsset = publicAssetPaths.has(pathname);
    if (!isLoginAsset) {
      const session = await requireSession(req, res);
      if (!session) return;
    }
    if (pathname === '/') pathname = '/app.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`) || filePath.includes(`${path.sep}.git${path.sep}`)) {
      return send(res, 403, 'Forbidden');
    }
    try {
      const data = await fs.readFile(filePath);
      const noCache = pathname.endsWith('.html') || pathname.endsWith('.webmanifest') || pathname === '/sw.js' || pathname === '/sw-v2.js';
      res.writeHead(200, {
        'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': noCache ? 'no-store' : 'public, max-age=3600'
      });
      res.end(data);
    } catch (error) {
      if (error.code === 'ENOENT') return send(res, 404, 'Not found');
      throw error;
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (error) {
      return send(res, 400, { error: error.message || 'bad request' });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, () => {
    console.log(`Three Smiles private server listening on http://127.0.0.1:${DEFAULT_PORT}`);
  });
}

module.exports = { createServer, sha256 };
