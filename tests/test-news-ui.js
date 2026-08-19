'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const edition = JSON.parse(fs.readFileSync('news/data/news.json', 'utf8'));
const html = fs.readFileSync('news/index.html', 'utf8');
const script = fs.readFileSync('news/assets/news.js', 'utf8');

function publisherFamily(story) {
  return story.publisher || story.source;
}

function assertPublisherCap(ids, cap, byId, label) {
  const counts = new Map();
  for (const id of ids) {
    const family = publisherFamily(byId.get(id));
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  assert.ok([...counts.values()].every(count => count <= cap), `${label} respects publisher cap ${cap}`);
}

function setup(snapshot = edition) {
  const dom = new JSDOM(html, {
    url: 'https://three-smiles.herbyprojects.com/news/',
    runScripts: 'outside-only'
  });
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  const requests = [];
  dom.window.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } });
  };
  dom.window.eval(script);
  return { dom, requests };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('checked-in schema v2 edition enforces Top 7, Editorial and diversity contracts', () => {
  assert.equal(edition.schemaVersion, 2);
  assert.equal(edition.topStoryIds.length, 7);
  assert.equal(new Set(edition.topStoryIds).size, 7);
  const editorialIds = edition.sectionStoryIds.Editorial;
  assert.equal(editorialIds.length, 10);
  assert.equal(new Set(editorialIds).size, 10);

  const byId = new Map(edition.stories.map(story => [story.id, story]));
  assert.ok(edition.topStoryIds.every(id => byId.has(id)));
  assert.ok(editorialIds.every(id => byId.has(id)));
  assertPublisherCap(edition.topStoryIds, edition.policies.topPublisherCap, byId, 'Top 7');
  for (const [section, ids] of Object.entries(edition.sectionStoryIds)) {
    if (section === 'Sports') continue; // Sports uses explicit team/competition coverage quotas.
    assertPublisherCap(ids, edition.policies.sectionPublisherCap, byId, section);
  }

  const editorial = editorialIds.map(id => byId.get(id));
  assert.equal(new Set(editorial.map(publisherFamily)).size, 5);
  assert.ok(editorial.every(story => story.category === 'Editorial'));
  assert.ok(editorial.every(story => story.wordCount >= edition.policies.editorialMinWords));
  assert.ok(editorial.every(story => Number.isInteger(story.readingMinutes) && story.readingMinutes > 0));
  assert.ok(editorial.every(story => typeof story.body === 'string' && story.body.length > 100));
});

test('active private UI loads the canonical edition and opens all Editorial long reads in app', async () => {
  const { dom, requests } = setup();
  await tick();
  const document = dom.window.document;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://herby9000.github.io/herbyprojects/news/data/news.json');
  assert.equal(document.querySelectorAll('#top-rail .story-card').length, 7);

  const editorialTab = document.querySelector('[data-filter="Editorial"]');
  assert.ok(editorialTab, 'Editorial is first-class navigation');
  editorialTab.click();
  const cards = [...document.querySelectorAll('.editorial-story')];
  assert.equal(cards.length, 10);
  assert.ok(cards.every(card => /min read.*words available/i.test(card.querySelector('.story-meta').textContent)));

  cards[0].querySelector('h3 button').click();
  assert.equal(document.querySelector('#reader').open, true);
  assert.ok(document.querySelectorAll('#reader-copy p').length > 1);
  assert.ok(document.querySelector('#reader-copy').textContent.length > 900);
  assert.match(document.querySelector('#reader-disclosure').textContent, /never fabricates/i);
  assert.equal(document.querySelector('#reader-source').getAttribute('target'), '_blank');
});

test('active UI rejects an incomplete Top 7 without rendering unsafe partial cards', async () => {
  const invalid = structuredClone(edition);
  invalid.topStoryIds.pop();
  const { dom } = setup(invalid);
  await tick();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('#top-rail .story-card').length, 0);
  assert.match(document.querySelector('#top-rail').textContent, /could not load/i);
  assert.equal(document.querySelector('.no-script').style.display, 'block');
});