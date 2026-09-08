#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createArticleService, NewsArticleError } = require('./news/article-service');

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_AUTH_FILE = process.env.AUTH_FILE || path.join(DEFAULT_DATA_DIR, 'auth.json');
const PUBLIC_DIR = __dirname;
const CANADIAN_TECH_CHALLENGE_ROUTE = '/projects/canadian-tech-challenge';
const CANADIAN_TECH_CHALLENGE_DIR = path.join(PUBLIC_DIR, 'public-projects', 'canadian-tech-challenge');
const CANADIAN_TECH_CHALLENGE_FILES = new Map([
  ['', 'index.html'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['data/questions.json', 'data/questions.json'],
  ['assets/styles.css', 'assets/styles.css'],
  ['assets/core.js', 'assets/core.js'],
  ['assets/app.js', 'assets/app.js'],
  ['assets/icon.svg', 'assets/icon.svg'],
  ['assets/icon-180.png', 'assets/icon-180.png'],
  ['assets/icon-192.png', 'assets/icon-192.png'],
  ['assets/icon-512.png', 'assets/icon-512.png']
]);
const MAX_BODY = 64 * 1024;
const SESSION_COOKIE = 'three_smiles_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH_STATES = 32;
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const OAUTH_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};

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
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const NEGOTIATED_VARY = 'Accept, Accept-Encoding';

function preferredRepresentation(acceptHeader) {
  if (!acceptHeader) return 'html';
  const ranges = String(acceptHeader).split(',').map((part, index) => {
    const [rawType, ...parameters] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.trim().split('=');
      if (key === 'q') q = Number(value);
    }
    const specificity = rawType === '*/*' ? 0 : rawType.endsWith('/*') ? 1 : 2;
    return { type: rawType, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, specificity, index };
  });

  function qualityFor(type) {
    const [major] = type.split('/');
    const matches = ranges.filter(range => range.type === type || range.type === `${major}/*` || range.type === '*/*');
    matches.sort((a, b) => b.specificity - a.specificity || a.index - b.index);
    return matches[0] || { q: 0, specificity: -1, index: Number.MAX_SAFE_INTEGER };
  }

  const markdown = qualityFor('text/markdown');
  const html = qualityFor('text/html');
  if (markdown.q <= 0 && html.q <= 0) return null;
  if (markdown.q !== html.q) return markdown.q > html.q ? 'markdown' : 'html';
  if (markdown.specificity !== html.specificity) return markdown.specificity > html.specificity ? 'markdown' : 'html';
  if (markdown.index !== html.index) return markdown.index < html.index ? 'markdown' : 'html';
  return 'html';
}

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

async function loadOAuthConfig(configFile, dataDir) {
  let webClient;
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    webClient = {
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uris: process.env.GOOGLE_OAUTH_CALLBACK_URL ? [process.env.GOOGLE_OAUTH_CALLBACK_URL] : []
    };
  } else {
    const parsed = JSON.parse(await fs.readFile(configFile, 'utf8'));
    webClient = parsed.web || parsed;
  }
  return normalizeOAuthConfig({
    clientId: webClient.client_id,
    clientSecret: webClient.client_secret,
    callbackUrl: process.env.GOOGLE_OAUTH_CALLBACK_URL || webClient.redirect_uris?.[0],
    expectedEmail: process.env.GOOGLE_OAUTH_EXPECTED_EMAIL || 'charlie@cmcc.vc',
    tokenPath: process.env.GOOGLE_OAUTH_TOKEN_PATH || path.join(dataDir, 'google-authorized-user.json')
  });
}

function normalizeOAuthConfig(config) {
  const normalized = {
    clientId: String(config?.clientId || '').trim(),
    clientSecret: String(config?.clientSecret || ''),
    callbackUrl: String(config?.callbackUrl || '').trim(),
    expectedEmail: String(config?.expectedEmail || 'charlie@cmcc.vc').trim().toLowerCase(),
    tokenPath: String(config?.tokenPath || '').trim()
  };
  let callback;
  try {
    callback = new URL(normalized.callbackUrl);
  } catch {
    throw new Error('invalid OAuth configuration');
  }
  if (!normalized.clientId || !normalized.clientSecret || !normalized.tokenPath || !normalized.expectedEmail ||
      callback.protocol !== 'https:' || callback.pathname !== '/oauth/google/callback' || callback.search || callback.hash) {
    throw new Error('invalid OAuth configuration');
  }
  return normalized;
}

async function writeAuthorizedUserToken(tokenPath, config, refreshToken) {
  const directory = path.dirname(tokenPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(tokenPath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const contents = JSON.stringify({
    type: 'authorized_user',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken
  }, null, 2);
  try {
    await fs.writeFile(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, tokenPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
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

async function sendFile(res, filePath, options = {}) {
  const data = await fs.readFile(filePath);
  res.writeHead(options.status || 200, {
    'content-type': options.contentType || mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': options.cacheControl || 'no-store',
    ...(options.vary ? { vary: options.vary } : {}),
    ...options.headers
  });
  res.end(data);
}

function sendPortfolio404(res) {
  const body = `# 404 — Herby Projects page not found\n\nThe requested path does not exist. Try one of these recovery points:\n\n- [Herby Projects home](https://herbyprojects.com/)\n- [XML sitemap](https://herbyprojects.com/sitemap.xml)\n- [Agent guidance](https://herbyprojects.com/llms.txt)\n- [About](https://herbyprojects.com/about)\n- [Contact](https://herbyprojects.com/contact)\n`;
  return send(res, 404, body, { 'content-type': 'text/markdown; charset=utf-8', vary: NEGOTIATED_VARY });
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

function parseHostAuthority(hostHeader = '') {
  const authority = String(hostHeader);
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function publicHost(hostHeader = '') {
  const parsed = parseHostAuthority(hostHeader);
  if (!parsed) return null;
  const origins = new Map([
    ['herbyprojects.com', 'https://herbyprojects.com'],
    ['www.herbyprojects.com', 'https://www.herbyprojects.com'],
    ['three-smiles.herbyprojects.com', 'https://three-smiles.herbyprojects.com']
  ]);
  const httpsOrigin = origins.get(parsed.hostname.toLowerCase());
  return httpsOrigin ? { hostname: parsed.hostname.toLowerCase(), httpsOrigin } : null;
}

function isPortfolioHost(hostHeader = '') {
  const host = publicHost(hostHeader);
  return host?.hostname === 'herbyprojects.com' || host?.hostname === 'www.herbyprojects.com';
}

function createServer(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const dataFile = options.dataFile || path.join(dataDir, 'entries.json');
  const authFile = options.authFile || DEFAULT_AUTH_FILE;
  const allowedOrigin = options.allowedOrigin ?? process.env.ALLOWED_ORIGIN;
  const newsArticleService = options.newsArticleService || createArticleService({ cacheRoot: path.join(dataDir, 'news-cache') });
  const oauthConfigFile = options.oauthConfigFile || process.env.GOOGLE_OAUTH_CLIENT_FILE || path.join(dataDir, 'google-oauth-client.json');
  const oauthFetch = options.oauthFetch || globalThis.fetch;
  const oauthNow = options.oauthNow || Date.now;
  const oauthProduction = options.oauthProduction ?? process.env.NODE_ENV === 'production';
  const pendingOAuthStates = new Map();
  let authPromise;
  let oauthConfigPromise;
  let storeWriteQueue = Promise.resolve();
  const getAuth = () => authPromise ||= loadAuth(authFile);
  const getOAuthConfig = () => oauthConfigPromise ||= options.oauth
    ? Promise.resolve().then(() => normalizeOAuthConfig(options.oauth))
    : loadOAuthConfig(oauthConfigFile, dataDir);

  function saveEntry(entry) {
    const operation = storeWriteQueue.then(async () => {
      const store = await readStore(dataFile);
      store.entries ||= {};
      store.entries[`${entry.date}::${entry.person}`] = entry;
      await writeStore(dataDir, dataFile, store);
    });
    storeWriteQueue = operation.catch(() => {});
    return operation;
  }

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

  function oauthSend(res, status, payload, headers = {}) {
    return send(res, status, payload, { ...OAUTH_SECURITY_HEADERS, ...headers });
  }

  function oauthPage(res, status, success) {
    const title = success ? 'CMCC inbox connected' : 'Connection unsuccessful';
    const message = success
      ? 'The CMCC inbox is connected. This tab may be closed.'
      : 'The connection could not be completed. Please close this tab and try again.';
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4ef;color:#18332d;font:17px/1.5 system-ui,-apple-system,sans-serif}main{box-sizing:border-box;width:min(92vw,32rem);padding:2.25rem;border:1px solid #d9ded8;border-radius:1.25rem;background:#fff;box-shadow:0 1rem 3rem #18332d18}h1{margin:0 0 .75rem;font-size:clamp(1.65rem,7vw,2.25rem);line-height:1.12}p{margin:0;color:#4b5f5a}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
    return oauthSend(res, status, body, { 'content-type': 'text/html; charset=utf-8' });
  }

  function garbageCollectOAuthStates() {
    const now = oauthNow();
    for (const [state, pending] of pendingOAuthStates) {
      if (pending.expiresAt <= now) pendingOAuthStates.delete(state);
    }
    while (pendingOAuthStates.size > MAX_PENDING_OAUTH_STATES) {
      pendingOAuthStates.delete(pendingOAuthStates.keys().next().value);
    }
  }

  function oauthRequestHasExpectedOrigin(req, config) {
    if (!oauthProduction) return true;
    const callback = new URL(config.callbackUrl);
    const requestHost = parseHostAuthority(req.headers.host);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
    return requestHost?.host.toLowerCase() === callback.host.toLowerCase() && forwardedProto === 'https';
  }

  async function requireCharlie(req, res) {
    const session = readSession(req, await getAuth());
    if (!session) {
      oauthSend(res, 401, { error: 'authentication required' });
      return false;
    }
    if (session.person !== 'Charlie') {
      oauthSend(res, 403, { error: 'forbidden' });
      return false;
    }
    return true;
  }

  async function handleOAuthStart(req, res) {
    if (!await requireCharlie(req, res)) return;
    let config;
    try {
      config = await getOAuthConfig();
    } catch {
      return oauthSend(res, 503, { error: 'OAuth is not configured' });
    }
    if (!oauthRequestHasExpectedOrigin(req, config)) return oauthPage(res, 400, false);

    garbageCollectOAuthStates();
    while (pendingOAuthStates.size >= MAX_PENDING_OAUTH_STATES) {
      pendingOAuthStates.delete(pendingOAuthStates.keys().next().value);
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pendingOAuthStates.set(state, { verifier, expiresAt: oauthNow() + OAUTH_STATE_TTL_MS });
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: 'code',
      scope: GMAIL_READONLY_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();
    return redirect(res, authorization.toString(), OAUTH_SECURITY_HEADERS);
  }

  async function handleOAuthCallback(req, res, url) {
    try {
      const config = await getOAuthConfig();
      if (!oauthRequestHasExpectedOrigin(req, config)) return oauthPage(res, 400, false);
      garbageCollectOAuthStates();
      const codes = url.searchParams.getAll('code');
      const states = url.searchParams.getAll('state');
      if (states.length !== 1 || !states[0]) {
        return oauthPage(res, 400, false);
      }
      const pending = pendingOAuthStates.get(states[0]);
      if (!pending || pending.expiresAt <= oauthNow()) return oauthPage(res, 400, false);
      pendingOAuthStates.delete(states[0]);
      if (url.searchParams.has('error') || codes.length !== 1 || !codes[0]) return oauthPage(res, 400, false);

      const tokenResponse = await oauthFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: codes[0],
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUrl,
          grant_type: 'authorization_code',
          code_verifier: pending.verifier
        }).toString()
      });
      if (!tokenResponse.ok) return oauthPage(res, 400, false);
      const token = await tokenResponse.json();
      const grantedScopes = String(token.scope || '').split(/\s+/).filter(Boolean);
      if (!token.access_token || !token.refresh_token ||
          grantedScopes.length !== 1 || grantedScopes[0] !== GMAIL_READONLY_SCOPE) {
        return oauthPage(res, 400, false);
      }

      const profileResponse = await oauthFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      if (!profileResponse.ok) return oauthPage(res, 400, false);
      const profile = await profileResponse.json();
      if (String(profile.emailAddress || '').trim().toLowerCase() !== config.expectedEmail) {
        return oauthPage(res, 400, false);
      }
      await writeAuthorizedUserToken(config.tokenPath, config, token.refresh_token);
      return oauthPage(res, 200, true);
    } catch {
      return oauthPage(res, 400, false);
    }
  }

  async function handleOAuthStatus(req, res) {
    if (!await requireCharlie(req, res)) return;
    garbageCollectOAuthStates();
    try {
      const config = await getOAuthConfig();
      if (!oauthRequestHasExpectedOrigin(req, config)) return oauthPage(res, 400, false);
      let connected = true;
      try {
        await fs.access(config.tokenPath);
      } catch {
        connected = false;
      }
      return oauthSend(res, 200, { configured: true, pending: pendingOAuthStates.size > 0, connected });
    } catch {
      return oauthSend(res, 200, { configured: false, pending: false, connected: false });
    }
  }

  async function handleOAuth(req, res, url) {
    if (req.method !== 'GET') return oauthSend(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/oauth/google/start') return handleOAuthStart(req, res);
    if (url.pathname === '/oauth/google/callback') return handleOAuthCallback(req, res, url);
    if (url.pathname === '/oauth/google/status') return handleOAuthStatus(req, res);
    return oauthSend(res, 404, { error: 'not found' });
  }

  async function requireSession(req, res, url) {
    const auth = await getAuth();
    const session = readSession(req, auth);
    if (!session) {
      if (req.url.startsWith('/api/')) send(res, 401, { error: 'login required' }, corsHeaders(req, allowedOrigin));
      else {
        const supportsReturnPath = url && (
          url.pathname === '/news' || url.pathname.startsWith('/news/') ||
          url.pathname === CANADIAN_TECH_CHALLENGE_ROUTE || url.pathname.startsWith(`${CANADIAN_TECH_CHALLENGE_ROUTE}/`)
        );
        const loginPath = supportsReturnPath ? `/login?next=${encodeURIComponent(url.pathname + url.search)}` : '/login';
        redirect(res, loginPath);
      }
      return null;
    }
    return session;
  }

  async function handleApi(req, res, url) {
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/news/')) {
      const session = await requireSession(req, res, url);
      if (!session) return;
      return send(res, 204, '', { ...corsHeaders(req, allowedOrigin), 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-credentials': 'true' });
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', { ...corsHeaders(req, allowedOrigin), 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-credentials': 'true' });
    if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(), ...corsHeaders(req, allowedOrigin) });
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, service: 'three-smiles-backend' });

    const session = await requireSession(req, res, url);
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
      await saveEntry(entry);
      return send(res, 200, { ok: true, entry }, corsHeaders(req, allowedOrigin));
    }

    if (url.pathname === '/api/news/article' && req.method === 'POST') {
      const payload = await parseBody(req);
      try {
        const result = await newsArticleService.extract(payload.url);
        return send(res, 200, result, corsHeaders(req, allowedOrigin));
      } catch (error) {
        const knownError = error instanceof NewsArticleError || (error.code && Number.isInteger(error.status));
        return send(res, knownError ? error.status : 502, {
          ok: false,
          fallback: true,
          code: knownError ? error.code : 'extraction_failed',
          error: 'Full article unavailable; showing the feed summary.'
        }, corsHeaders(req, allowedOrigin));
      }
    }

    return send(res, 404, { error: 'not found' }, corsHeaders(req, allowedOrigin));
  }

  async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    const portfolioHost = isPortfolioHost(req.headers.host);

    if (portfolioHost) {
      if (pathname === CANADIAN_TECH_CHALLENGE_ROUTE || pathname.startsWith(`${CANADIAN_TECH_CHALLENGE_ROUTE}/`)) {
        const session = await requireSession(req, res, url);
        if (!session) return;
      }
      if (pathname === CANADIAN_TECH_CHALLENGE_ROUTE) {
        return redirect(res, `${CANADIAN_TECH_CHALLENGE_ROUTE}/`);
      }
      if (pathname.startsWith(`${CANADIAN_TECH_CHALLENGE_ROUTE}/`)) {
        const relativePath = pathname.slice(CANADIAN_TECH_CHALLENGE_ROUTE.length + 1);
        const allowedPath = CANADIAN_TECH_CHALLENGE_FILES.get(relativePath);
        if (!allowedPath) return sendPortfolio404(res);
        const noCache = allowedPath === 'index.html' || allowedPath === 'manifest.webmanifest';
        return sendFile(res, path.join(CANADIAN_TECH_CHALLENGE_DIR, allowedPath), {
          cacheControl: noCache ? 'no-store' : 'public, max-age=3600'
        });
      }

      const negotiatedPages = new Map([
        ['/', { html: '/portfolio.html', markdown: '/portfolio.md' }],
        ['/index.html', { html: '/portfolio.html', markdown: '/portfolio.md' }],
        ['/portfolio.html', { html: '/portfolio.html', markdown: '/portfolio.md' }],
        ['/about', { html: '/about.html', markdown: '/about.md' }],
        ['/contact', { html: '/contact.html', markdown: '/contact.md' }],
        ['/privacy', { html: '/privacy.html', markdown: '/privacy.md' }]
      ]);
      if (['/about.html', '/contact.html', '/privacy.html'].includes(pathname)) {
        return redirect(res, pathname.replace(/\.html$/, ''));
      }
      if (negotiatedPages.has(pathname)) {
        const representation = preferredRepresentation(req.headers.accept);
        if (!representation) return send(res, 406, 'Not Acceptable', { vary: NEGOTIATED_VARY });
        const selectedPath = negotiatedPages.get(pathname)[representation];
        return sendFile(res, path.join(PUBLIC_DIR, selectedPath), { vary: NEGOTIATED_VARY });
      }

      const portfolioRoutes = new Map([
        ['/three-smiles', '/three-smiles.html'],
        ['/projects/three-smiles', '/three-smiles.html']
      ]);
      if (portfolioRoutes.has(pathname)) pathname = portfolioRoutes.get(pathname);
      else if (pathname === '/login') pathname = '/login.html';

      const portfolioAssetPaths = new Set([
        '/three-smiles.html',
        '/login.html',
        '/favicon.ico',
        '/site.webmanifest',
        '/assets/icon.svg',
        '/assets/apple-touch-icon.png',
        '/assets/icon-192.png',
        '/assets/icon-512.png',
        '/assets/herby-favicon.svg',
        '/assets/herby-apple-touch-icon.png',
        '/assets/herby-projects-og.svg',
        '/assets/herby-projects-og.png',
        '/assets/ros-morris-tulip.jpg',
        '/llms.txt',
        '/robots.txt',
        '/sitemap.xml'
      ]);
      if (!portfolioAssetPaths.has(pathname)) return sendPortfolio404(res);
    }

    if (!portfolioHost && pathname === '/news') return redirect(res, '/news/');
    if (!portfolioHost && pathname === '/news/') {
      const representation = preferredRepresentation(req.headers.accept);
      if (!representation) return send(res, 406, 'Not Acceptable', { vary: NEGOTIATED_VARY });
      if (representation === 'markdown') {
        return sendFile(res, path.join(PUBLIC_DIR, '/news/public.md'), { vary: NEGOTIATED_VARY });
      }
      const auth = await getAuth();
      const session = readSession(req, auth);
      const selectedPath = session ? '/news/index.html' : '/news/public.html';
      return sendFile(res, path.join(PUBLIC_DIR, selectedPath), { vary: NEGOTIATED_VARY });
    }

    if (pathname === '/login') pathname = '/login.html';
    const publicAssetPaths = new Set([
      '/portfolio.html',
      '/three-smiles.html',
      '/favicon.ico',
      '/assets/herby-favicon.svg',
      '/assets/herby-apple-touch-icon.png',
      '/assets/herby-projects-og.png',
      '/assets/ros-morris-tulip.jpg',
      '/login.html',
      '/site.webmanifest',
      '/sw.js',
      '/sw-v2.js',
      '/assets/icon.svg',
      '/assets/apple-touch-icon.png',
      '/assets/icon-192.png',
      '/assets/icon-512.png',
      '/news/manifest.webmanifest',
      '/news/daily-seven-icon.svg',
      '/news/daily-seven-apple-touch-icon.png',
      '/news/daily-seven-icon-192.png',
      '/news/daily-seven-icon-512.png'
    ]);
    const isPublicAsset = publicAssetPaths.has(pathname);
    if (!portfolioHost && !isPublicAsset) {
      const session = await requireSession(req, res, url);
      if (!session) return;
    }
    if (pathname === '/') pathname = '/app.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`) || filePath.includes(`${path.sep}.git${path.sep}`)) {
      return send(res, 403, 'Forbidden');
    }
    try {
      const noCache = pathname.endsWith('.html') || pathname.endsWith('.webmanifest') || pathname === '/sw.js' || pathname === '/sw-v2.js';
      return await sendFile(res, filePath, { cacheControl: noCache ? 'no-store' : 'public, max-age=3600' });
    } catch (error) {
      if (error.code === 'ENOENT') return portfolioHost ? sendPortfolio404(res) : send(res, 404, 'Not found');
      throw error;
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const host = publicHost(req.headers.host);
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const oauthRequest = url.pathname.startsWith('/oauth/google/');
      if (!host && forwardedProto === 'http' && oauthRequest) {
        return oauthSend(res, 400, { error: 'bad request' });
      }
      if (host && forwardedProto === 'http') {
        res.writeHead(301, {
          ...(oauthRequest ? OAUTH_SECURITY_HEADERS : { 'cache-control': 'no-store' }),
          location: `${host.httpsOrigin}${url.pathname}${url.search}`
        });
        return res.end('Moved Permanently');
      }
      if (host && forwardedProto === 'https') {
        res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
      }
      if (oauthRequest) return await handleOAuth(req, res, url);
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
