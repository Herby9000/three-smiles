'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('login.html', 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://three-smiles.herbyprojects.com/login'
});

function returnPath(rawQuery = '') {
  dom.window.history.replaceState({}, '', `/login${rawQuery}`);
  return dom.window.loginReturnPath();
}

assert.equal(returnPath('?next=%2Fnews'), '/news');
assert.equal(returnPath('?next=%2Fnews%2F'), '/news/');
assert.equal(returnPath('?next=%2Fnews%2Farchive%2Ftoday%3Fedition%3Duk%26view%3Dcompact'), '/news/archive/today?edition=uk&view=compact');

for (const malicious of [
  '?next=https%3A%2F%2Fevil.example%2Fnews%2F',
  '?next=%2F%2Fevil.example%2Fnews%2F',
  '?next=%252Fnews%252F',
  '?next=%2Fnews%2F%252e%252e%2F',
  '?next=%2Fnews%2F..%2F',
  '?next=%2Fnews%5C%5Cevil.example%2F',
  '?next=%5C%5Cevil.example%5Cnews',
  '?next=%2Fnewsroom',
  '?next=%2F',
  '?next=%E0%A4%A',
  '?next=%2Fnews%00%2Fevil',
  '?next=',
  ''
]) {
  assert.equal(returnPath(malicious), '/', malicious);
}
