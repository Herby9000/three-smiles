'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');

assert.match(html, /id="loginGate"/, 'renders a login gate before the app');
assert.match(html, /id="appShell"[^>]*hidden/, 'keeps the app shell hidden until login succeeds');
assert.match(html, /Charlie/, 'Charlie is an allowed user');
assert.match(html, /Daisy/, 'Daisy is an allowed user');
assert.match(html, /AUTH_USERS/, 'defines explicit auth users');
assert.match(html, /crypto\.subtle\.digest\('SHA-256'/, 'uses Web Crypto SHA-256 for passcode checks');
assert.doesNotMatch(html, /smile-charlie|smile-daisy|letmein|123456/i, 'does not include obvious plaintext passcodes');
assert.match(html, /sessionStorage\.setItem\(AUTH_SESSION_KEY/, 'stores a successful login for this browser session');
assert.match(html, /logoutButton/, 'provides a way to lock the app again');
