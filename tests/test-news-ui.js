'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const edition = JSON.parse(fs.readFileSync('news/data/news.json', 'utf8'));
const html = fs.readFileSync('news/index.html', 'utf8');
const script = fs.readFileSync('news/assets/news.js', 'utf8');
const styles = fs.readFileSync('news/assets/news.css', 'utf8');

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

  assert.ok(cards.every(card => card.getAttribute('role') === 'button' && card.tabIndex === 0));
  assert.ok(cards.every(card => card.querySelectorAll('button, a, input, select, textarea').length === 0));
  cards[0].click();
  assert.equal(document.querySelector('#reader').open, true);
  assert.ok(document.querySelectorAll('#reader-copy p').length > 1);
  assert.ok(document.querySelector('#reader-copy').textContent.length > 900);
  assert.match(document.querySelector('#reader-disclosure').textContent, /never fabricates/i);
  assert.equal(document.querySelector('#reader-source').getAttribute('target'), '_blank');
});

test('Top 7 cards are accessible controls that open without nested interactive elements', async () => {
  const { dom } = setup();
  await tick();
  const document = dom.window.document;
  const card = document.querySelector('#top-rail .story-card');
  const title = card.querySelector('h3').textContent;

  assert.equal(card.getAttribute('role'), 'button');
  assert.equal(card.tabIndex, 0);
  assert.match(card.getAttribute('aria-label'), new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(card.querySelectorAll('button, a, input, select, textarea').length, 0);
  assert.match(card.querySelector('.read-cue').textContent, /read in app/i);

  card.click();
  assert.equal(document.querySelector('#reader').open, true);
  assert.equal(document.querySelector('#reader-title').textContent, title);
});

test('Top 7 cards activate with Enter and Space and retain a visible focus treatment', async () => {
  const { dom } = setup();
  await tick();
  const document = dom.window.document;
  const cards = document.querySelectorAll('#top-rail .story-card');

  cards[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.querySelector('#reader-title').textContent, cards[0].querySelector('h3').textContent);
  document.querySelector('#reader').close();

  const space = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  cards[1].dispatchEvent(space);
  assert.equal(space.defaultPrevented, true);
  assert.equal(document.querySelector('#reader-title').textContent, cards[1].querySelector('h3').textContent);
  assert.match(styles, /\.story-card:focus-visible(?:,[^{]+)?\{[^}]*outline:/);
});

test('horizontal pointer drags scroll the Top 7 rail without opening a card', async () => {
  const { dom } = setup();
  await tick();
  const document = dom.window.document;
  const card = document.querySelector('#top-rail .story-card');
  const pointerEvent = (type, clientX, clientY) => {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.defineProperties(event, {
      clientX: { value: clientX },
      clientY: { value: clientY }
    });
    return event;
  };

  card.dispatchEvent(pointerEvent('pointerdown', 180, 20));
  card.dispatchEvent(pointerEvent('pointermove', 90, 22));
  card.dispatchEvent(pointerEvent('pointerup', 90, 22));
  card.click();

  assert.equal(document.querySelector('#reader').open, false);
});

test('reader close control is sleek, touch-safe and sticky on safe-area iPhones', () => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const reader = document.querySelector('#reader');
  const toolbar = reader.querySelector(':scope > .reader-toolbar');
  const close = toolbar?.querySelector('.close-reader');

  assert.ok(toolbar, 'the sticky toolbar is not constrained by a short form ancestor');
  assert.equal(close?.getAttribute('aria-label'), 'Close reader');
  assert.ok(close.querySelector('svg[aria-hidden="true"]'), 'close uses a custom icon');
  assert.equal(close.textContent.trim(), '', 'close icon is not a letter or text glyph');
  assert.match(styles, /\.reader-toolbar\{[^}]*position:sticky[^}]*top:0[^}]*z-index:/);
  assert.match(styles, /\.reader-toolbar\{[^}]*safe-area-inset-top[^}]*safe-area-inset-right[^}]*safe-area-inset-left/);
  assert.match(styles, /\.reader-toolbar\{[^}]*border:0[^}]*background:transparent/);
  assert.match(styles, /\.close-reader\{[^}]*min-width:44px[^}]*min-height:44px/);
  assert.match(styles, /\.close-reader\{[^}]*border:[^;}]*rgba\([^}]*background:rgba\([^}]*box-shadow:/);
  assert.match(styles, /\.close-reader:focus-visible\{[^}]*outline:/);
  assert.equal(toolbar.nextElementSibling?.classList.contains('reader-paper'), true, 'toolbar occupies its own row above article text');
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