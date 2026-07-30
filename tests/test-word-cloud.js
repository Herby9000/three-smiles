'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('app.html', 'utf8');
const start = html.indexOf('const WORD_CLOUD_STOP_WORDS');
const end = html.indexOf('function lastNDates', start);
assert.ok(start >= 0 && end > start, 'word-cloud filtering implementation is present');

const implementation = html.slice(start, end);
const sample = `
  Being able to have coffee with Daisy was really nice.
  I actually thought I wanted something, but I like how the garden flowers bloom.
  Being with Daisy and our family made me happy after a long woodland walk and dinner with friends.
`;
const context = { sample, result: null };
vm.createContext(context);
vm.runInContext(`${implementation}\nresult = countWords(sample);`, context);

const counts = Object.fromEntries(context.result.map(([word, count]) => [word, count]));
for (const filler of ['being', 'able', 'have', 'with', 'really', 'like', 'how', 'was', 'and', 'our', 'were', 'after', 'actually', 'thought', 'wanted']) {
  assert.equal(counts[filler], undefined, `filters filler word: ${filler}`);
}

assert.equal(counts.daisy, 2, 'keeps and counts a meaningful name');
for (const meaningful of ['coffee', 'garden', 'flowers', 'bloom', 'family', 'happy', 'woodland', 'walk', 'dinner', 'friends']) {
  assert.ok(counts[meaningful] >= 1, `keeps meaningful word: ${meaningful}`);
}
assert.deepEqual(Array.from(context.result[0]), ['daisy', 2], 'ranks the most frequent meaningful word first');
