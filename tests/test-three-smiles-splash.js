'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const splash = fs.readFileSync('three-smiles.html', 'utf8');
const portfolio = fs.readFileSync('portfolio.html', 'utf8');

assert.match(splash, /data-page="three-smiles-showcase"/, 'renders the public Three Smiles showcase');
assert.match(splash, /Three small moments/, 'showcase has a memorable product promise');
assert.match(splash, /How it works/, 'showcase explains the daily ritual');
assert.match(splash, /A shared memory lane/, 'showcase explains the long-term value');
assert.match(splash, /Private by design/, 'showcase makes the privacy boundary explicit');
assert.match(splash, /No public sign-up/, 'showcase clearly states there is no public access');
assert.match(splash, /aria-label="Three Smiles app preview"/, 'showcase includes an accessible product preview');
assert.doesNotMatch(splash, /href="[^"]*(?:three-smiles\.herbyprojects\.com|\/login)/, 'showcase never links visitors to the private app or login');
assert.doesNotMatch(splash, />\s*(?:Open app|Sign in|Log in)\s*</i, 'showcase has no private-app access CTA');
assert.ok((portfolio.match(/href="\/projects\/three-smiles"/g) || []).length >= 2, 'portfolio hero and project card link to the public showcase');
assert.doesNotMatch(portfolio, /href="https:\/\/three-smiles\.herbyprojects\.com"/, 'portfolio does not expose direct links to the private app');
