'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createServer } = require('../server');

const CALLBACK_URL = 'https://three-smiles.herbyprojects.com/oauth/google/callback';
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

async function startServer(overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'three-smiles-oauth-'));
  const authFile = path.join(temp, 'auth.json');
  const tokenPath = path.join(temp, 'google-token.json');
  await fs.writeFile(authFile, JSON.stringify({
    sessionSecret: 'test-session-secret-with-enough-length',
    users: {
      Charlie: crypto.createHash('sha256').update('charlie-pass').digest('hex'),
      Daisy: crypto.createHash('sha256').update('daisy-pass').digest('hex')
    }
  }));

  const requests = [];
  const fetchImpl = overrides.fetchImpl || (async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        scope: GMAIL_READONLY,
        token_type: 'Bearer'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ emailAddress: 'charlie@cmcc.vc' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  const oauthConfigFile = path.join(temp, 'google-web-client.json');
  if (overrides.useClientFile) {
    await fs.writeFile(oauthConfigFile, JSON.stringify({ web: {
      client_id: 'web-client-id.apps.googleusercontent.com',
      client_secret: 'client-secret-value',
      redirect_uris: [CALLBACK_URL]
    } }));
  }
  let now = Date.parse('2026-09-08T01:00:00Z');
  const server = createServer({
    dataDir: temp,
    authFile,
    oauth: overrides.useClientFile ? null : {
      clientId: 'web-client-id.apps.googleusercontent.com',
      clientSecret: 'client-secret-value',
      callbackUrl: CALLBACK_URL,
      tokenPath,
      expectedEmail: 'charlie@cmcc.vc'
    },
    oauthConfigFile,
    oauthFetch: fetchImpl,
    oauthNow: () => now,
    ...overrides.serverOptions
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login(person) {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person, passcode: `${person.toLowerCase()}-pass` })
    });
    return response.headers.get('set-cookie').split(';')[0];
  }

  return {
    base,
    temp,
    tokenPath,
    requests,
    login,
    advance(milliseconds) { now += milliseconds; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
}

function rawGet(base, pathname, headers) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: target.hostname, port: target.port, path: pathname, headers }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers) }));
    });
    request.on('error', reject);
  });
}

async function begin(app, cookie) {
  const response = await fetch(`${app.base}/oauth/google/start`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual'
  });
  const location = response.headers.get('location');
  const authorization = location && /^https?:\/\//.test(location) ? new URL(location) : null;
  return { response, authorization };
}

test('OAuth start and status require Charlie and request only Gmail readonly with PKCE', async () => {
  const app = await startServer();
  try {
    const anonymous = await begin(app);
    assert.equal(anonymous.response.status, 401);
    assertSecurityHeaders(anonymous.response);

    const daisy = await begin(app, await app.login('Daisy'));
    assert.equal(daisy.response.status, 403);
    const daisyStatus = await fetch(`${app.base}/oauth/google/status`, { headers: { cookie: await app.login('Daisy') } });
    assert.equal(daisyStatus.status, 403);

    const charlieCookie = await app.login('Charlie');
    const started = await begin(app, charlieCookie);
    assert.equal(started.response.status, 302);
    assertSecurityHeaders(started.response);
    assert.equal(started.authorization.origin + started.authorization.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(started.authorization.searchParams.get('scope'), GMAIL_READONLY);
    assert.equal(started.authorization.searchParams.getAll('scope').length, 1);
    assert.equal(started.authorization.searchParams.get('access_type'), 'offline');
    assert.equal(started.authorization.searchParams.get('prompt'), 'consent');
    assert.equal(started.authorization.searchParams.get('redirect_uri'), CALLBACK_URL);
    assert.equal(started.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(started.authorization.searchParams.get('state'), /^[A-Za-z0-9_-]{40,}$/);
    assert.match(started.authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{40,}$/);

    const status = await fetch(`${app.base}/oauth/google/status`, { headers: { cookie: charlieCookie } });
    assert.deepEqual(await status.json(), { configured: true, pending: true, connected: false });
    assertSecurityHeaders(status);
  } finally {
    await app.close();
  }
});

test('callback state expires after ten minutes and is consumed once before exchange', async () => {
  const app = await startServer();
  try {
    const cookie = await app.login('Charlie');
    const first = await begin(app, cookie);
    const state = first.authorization.searchParams.get('state');
    app.advance(10 * 60 * 1000);
    const expired = await fetch(`${app.base}/oauth/google/callback?code=one&state=${state}`);
    assert.equal(expired.status, 400);
    assert.equal(app.requests.length, 0);

    const second = await begin(app, cookie);
    const liveState = second.authorization.searchParams.get('state');
    const incomplete = await fetch(`${app.base}/oauth/google/callback?state=${liveState}`);
    assert.equal(incomplete.status, 400);
    const consumed = await fetch(`${app.base}/oauth/google/callback?code=authorization-code&state=${liveState}`);
    assert.equal(consumed.status, 400);
    assert.equal(app.requests.length, 0);

    const third = await begin(app, cookie);
    const successfulState = third.authorization.searchParams.get('state');
    const success = await fetch(`${app.base}/oauth/google/callback?code=authorization-code&state=${successfulState}`);
    assert.equal(success.status, 200);
    assert.match(await success.text(), /CMCC inbox is connected/);
    const replay = await fetch(`${app.base}/oauth/google/callback?code=authorization-code&state=${successfulState}`);
    assert.equal(replay.status, 400);
    assert.equal(app.requests.length, 2);

    const tokenExchange = app.requests[0];
    const params = new URLSearchParams(tokenExchange.options.body);
    assert.equal(params.get('code'), 'authorization-code');
    assert.equal(params.get('code_challenge'), null);
    assert.ok(params.get('code_verifier'));
    assert.equal(digest(params.get('code_verifier')), third.authorization.searchParams.get('code_challenge'));
  } finally {
    await app.close();
  }
});

test('callback rejects malformed responses, insufficient scope, and wrong Gmail identity without leaking secrets', async () => {
  const cases = [
    { query: '', expectedRequests: 0 },
    { query: '?error=access_denied&state=anything', expectedRequests: 0 },
    { query: '?code=secret-code&state=wrong-state', expectedRequests: 0 }
  ];
  for (const item of cases) {
    const app = await startServer();
    try {
      const response = await fetch(`${app.base}/oauth/google/callback${item.query}`);
      const body = await response.text();
      assert.equal(response.status, 400);
      assertSecurityHeaders(response);
      assert.doesNotMatch(body, /secret-code|access_denied|wrong-state|client-secret-value|refresh-secret/);
      assert.equal(app.requests.length, item.expectedRequests);
    } finally {
      await app.close();
    }
  }

  for (const tokenResult of [
    { access_token: 'access-secret', refresh_token: 'refresh-secret', scope: 'openid' },
    { access_token: 'access-secret', refresh_token: 'refresh-secret', scope: GMAIL_READONLY, wrongIdentity: true }
  ]) {
    const app = await startServer({
      fetchImpl: async url => String(url).includes('/token')
        ? new Response(JSON.stringify(tokenResult), { status: 200 })
        : new Response(JSON.stringify({ emailAddress: tokenResult.wrongIdentity ? 'someone@example.com' : 'charlie@cmcc.vc' }), { status: 200 })
    });
    try {
      const started = await begin(app, await app.login('Charlie'));
      const state = started.authorization.searchParams.get('state');
      const response = await fetch(`${app.base}/oauth/google/callback?code=secret-code&state=${state}`);
      const body = await response.text();
      assert.equal(response.status, 400);
      assert.doesNotMatch(body, /secret-code|access-secret|refresh-secret|someone@example.com|client-secret-value/);
      await assert.rejects(fs.access(app.tokenPath));
    } finally {
      await app.close();
    }
  }
});

test('successful callback atomically replaces an authorized-user token file with mode 0600', async () => {
  const app = await startServer();
  try {
    await fs.writeFile(app.tokenPath, 'old-token-file', { mode: 0o644 });
    const before = await fs.stat(app.tokenPath);
    const started = await begin(app, await app.login('Charlie'));
    const state = started.authorization.searchParams.get('state');
    const response = await fetch(`${app.base}/oauth/google/callback?code=secret-code&state=${state}`);
    assert.equal(response.status, 200);
    assertSecurityHeaders(response);

    const after = await fs.stat(app.tokenPath);
    assert.notEqual(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(app.tokenPath, 'utf8')), {
      type: 'authorized_user',
      client_id: 'web-client-id.apps.googleusercontent.com',
      client_secret: 'client-secret-value',
      refresh_token: 'refresh-secret'
    });
    const files = await fs.readdir(app.temp);
    assert.equal(files.some(name => name.includes('.tmp')), false);
  } finally {
    await app.close();
  }
});

test('production OAuth endpoints require the configured HTTPS public origin', async () => {
  const app = await startServer({ serverOptions: { oauthProduction: true } });
  try {
    const cookie = await app.login('Charlie');
    const rejected = await begin(app, cookie);
    assert.equal(rejected.response.status, 400);
    assertSecurityHeaders(rejected.response);

    const accepted = await rawGet(app.base, '/oauth/google/start', {
      cookie,
      host: 'three-smiles.herbyprojects.com',
      'x-forwarded-proto': 'https'
    });
    assert.equal(accepted.status, 302);
    assertSecurityHeaders(accepted);
  } finally {
    await app.close();
  }
});

test('standard Google web client JSON is accepted with the default expected identity', async () => {
  const app = await startServer({ useClientFile: true });
  try {
    const started = await begin(app, await app.login('Charlie'));
    assert.equal(started.response.status, 302);
    assert.equal(started.authorization.searchParams.get('client_id'), 'web-client-id.apps.googleusercontent.com');
    assert.equal(started.authorization.searchParams.get('redirect_uri'), CALLBACK_URL);
    const state = started.authorization.searchParams.get('state');
    const callback = await fetch(`${app.base}/oauth/google/callback?code=authorization-code&state=${state}`);
    assert.equal(callback.status, 200);
    const stored = JSON.parse(await fs.readFile(path.join(app.temp, 'google-authorized-user.json'), 'utf8'));
    assert.equal(stored.type, 'authorized_user');
  } finally {
    await app.close();
  }
});