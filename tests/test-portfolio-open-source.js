'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('portfolio.html', 'utf8');
const repositories = [
  'three-smiles',
  'rugby-next-match',
  'blue-jays-playoff-dashboard',
  'uno-watch-display',
  'toronto-entertainment',
  'sticklab'
];

assert.match(html, /The apps are personal\. The code is public\./, 'hero makes the open-source promise unmistakable');
assert.match(html, /id="open-source"/, 'portfolio has a dedicated open-source section');
assert.match(html, /Every project is open source/, 'open-source section states the portfolio-wide policy');
assert.match(html, /href="https:\/\/github\.com\/Herby9000"[^>]*target="_blank"[^>]*rel="noopener"/, 'portfolio links prominently to the GitHub profile');
assert.match(html, /href="https:\/\/github\.com\/Herby9000\/herbyprojects"[^>]*target="_blank"[^>]*rel="noopener"/, 'portfolio links directly to its own source repository');
for (const repo of repositories) {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(html, new RegExp(`href="https://github\\.com/Herby9000/${escaped}"[^>]*target="_blank"[^>]*rel="noopener"`), `${repo} card links to its public source repository`);
}
assert.equal((html.match(/class="source-link"/g) || []).length, repositories.length, 'every project card has one source-code link');
