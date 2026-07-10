'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sw = fs.readFileSync('sw-v2.js', 'utf8');

assert.match(sw, /three-smiles-v2/, 'service worker cache was version-bumped');
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'service worker detects API requests');
assert.match(sw, /fetch\(event\.request, \{ cache: 'no-store' \}\)/, 'API requests bypass cache');
assert.doesNotMatch(sw, /cache\.put\(event\.request, copy\)[\s\S]*pathname\.startsWith\('\/api\/'\)/, 'API responses are not cached');
assert.match(sw, /event\.request\.mode === 'navigate'/, 'navigations are handled separately');
