'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appHtml = fs.readFileSync('app.html', 'utf8');
const publicHtml = fs.readFileSync('index.html', 'utf8');
const loginHtml = fs.readFileSync('login.html', 'utf8');

assert.match(loginHtml, /id="loginForm"/, 'renders a server-backed login form');
assert.match(loginHtml, /fetch\('\/api\/login'/, 'login form posts to the server login API');
assert.match(loginHtml, /Charlie/, 'Charlie is an allowed login choice');
assert.match(loginHtml, /Daisy/, 'Daisy is an allowed login choice');
assert.doesNotMatch(loginHtml + appHtml + publicHtml, /AUTH_USERS|crypto\.subtle\.digest|17bec99a|ba682e70|XS17-oolSyL-YJHC|BZo5YOiCmKyFaewc/, 'client files do not contain passcode hashes or plaintext passcodes');
assert.doesNotMatch(publicHtml, /What made today good|\/api\/entries/, 'public GitHub Pages shell does not expose the app interface');
assert.doesNotMatch(appHtml, /id="loginGate"|id="appShell" hidden/, 'app shell is not protected by a fake client-only gate');
assert.match(appHtml, /fetch\('\/api\/me'/, 'app loads the current server-authenticated user');
assert.match(appHtml, /fetch\('\/api\/logout'/, 'app can log out through the server');
assert.match(appHtml, /\/api\/entries/, 'app syncs entries through the protected server API');
assert.doesNotMatch(appHtml, /localEntries/, 'startup sync does not re-upload stale browser-cached entries');
assert.doesNotMatch(appHtml, /Share with each other|share-today|shareToday|navigator\.share|navigator\.clipboard/, 'app has no external sharing controls or native share behavior');
assert.equal((appHtml.match(/>Save today<\/button>/g) || []).length, 2, 'both in-app Save today controls remain available');
assert.match(appHtml, /navigator\.serviceWorker\.register\('sw-v2\.js'\)/, 'app registers the cache-busting v2 service worker');
