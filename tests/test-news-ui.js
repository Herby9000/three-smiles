'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const fixture = {
  generatedAt: '2026-08-15T08:00:00Z',
  topStoryIds: Array.from({ length: 7 }, (_, index) => `top-${index + 1}`),
  stories: [
    ...Array.from({ length: 7 }, (_, index) => ({ id: `top-${index + 1}`, title: `Top ${index + 1}`, summary: `Summary ${index + 1}`, url: `https://www.bbc.com/top-${index + 1}`, imageUrl: `https://ichef.bbci.co.uk/news/fixture-${index + 1}.jpg`, source: 'BBC', category: index < 2 ? 'Politics' : index < 4 ? 'Tech' : 'Economics', published: '2026-08-15T07:00:00Z' })),
    { id: 'politics-extra', title: 'Politics Extra', summary: 'Political summary', url: 'https://www.npr.org/politics-extra', source: 'NPR', category: 'Politics' },
    { id: 'tech-extra', title: 'Tech Extra', summary: 'Technology summary', url: 'https://arstechnica.com/tech-extra', source: 'Ars Technica', category: 'Tech' },
    { id: 'economics-extra', title: 'Economics Extra', summary: 'Economic summary', url: 'https://www.theguardian.com/business/economics-extra', source: 'The Guardian', category: 'Economics' },
    { id: 'sports-extra', title: 'Sports Extra', summary: 'Sports summary', url: 'https://www.sportsnet.ca/sports-extra', source: 'Sportsnet', category: 'Sports' }
  ]
};

function setup(articleFetch, snapshot = fixture) {
  const html = fs.readFileSync('news/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'https://three-smiles.herbyprojects.com/news/' });
  const { createNewsApp } = require('../news/news');
  const fetchImpl = async (url, options) => {
    if (url === 'fixture://snapshot') return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } });
    return articleFetch(url, options);
  };
  const app = createNewsApp({ document: dom.window.document, fetchImpl, snapshotUrl: 'fixture://snapshot' });
  return { dom, app };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('valid Today edition shows exactly seven image-bearing, sport-free cards and no category grids', async () => {
  const { dom, app } = setup(async () => new Response('{}'));
  await app.start();
  const document = dom.window.document;
  const cards = [...document.querySelectorAll('#topStories .story-card')];
  const images = [...document.querySelectorAll('#topStories .story-image')];
  assert.equal(cards.length, 7);
  assert.equal(images.length, 7);
  assert.ok(cards.every(card => card.dataset.category !== 'Sports'));
  assert.ok(images.every(image => image.src.startsWith('https://ichef.bbci.co.uk/')));
  assert.ok(images.every(image => image.alt === '' && image.getAttribute('decoding') === 'async'));
  assert.ok(images.every(image => image.getAttribute('referrerpolicy') === 'no-referrer'));
  assert.equal(document.querySelector('#leadSection').hidden, false);
  assert.equal(document.querySelectorAll('#sectionStories .story-card').length, 0);
  assert.equal(document.querySelectorAll('#sectionStories .story-grid').length, 0);
});

test('Economics and existing category tabs filter without the lead; Today restores only the lead', async () => {
  const { dom, app } = setup(async () => new Response('{}'));
  await app.start();
  const document = dom.window.document;
  const sections = [...document.querySelectorAll('[data-section]')].map(button => button.dataset.section);
  assert.deepEqual(sections, ['Today', 'Politics', 'Tech', 'Economics', 'Sports']);

  for (const section of ['Politics', 'Tech', 'Economics', 'Sports']) {
    document.querySelector(`[data-section="${section}"]`).click();
    assert.equal(document.querySelector('#leadSection').hidden, true, `${section} hides lead`);
    const cards = [...document.querySelectorAll('#sectionStories .story-card')];
    assert.ok(cards.length > 0);
    assert.ok(cards.every(card => card.dataset.category === section), `${section} only`);
  }

  document.querySelector('[data-section="Today"]').click();
  assert.equal(document.querySelector('#leadSection').hidden, false);
  assert.equal(document.querySelectorAll('#topStories .story-card').length, 7);
  assert.equal(document.querySelectorAll('#sectionStories .story-card').length, 0);
  assert.equal(document.querySelectorAll('#sectionStories .story-grid').length, 0);
});

test('invalid Top 7 editions are rejected with an honest edition error', async t => {
  const invalidEditions = [
    ['non-seven count', snapshot => { snapshot.topStoryIds.pop(); }],
    ['missing top story', snapshot => { snapshot.topStoryIds[3] = 'not-in-stories'; }],
    ['Sports in top IDs', snapshot => { snapshot.stories.find(story => story.id === 'top-3').category = 'Sports'; }],
    ['missing image URL', snapshot => { delete snapshot.stories.find(story => story.id === 'top-4').imageUrl; }],
    ['unsafe image URL', snapshot => { snapshot.stories.find(story => story.id === 'top-5').imageUrl = 'http://images.example.test/story.jpg'; }]
  ];

  for (const [name, mutate] of invalidEditions) {
    await t.test(name, async () => {
      const snapshot = structuredClone(fixture);
      mutate(snapshot);
      const { dom, app } = setup(async () => new Response('{}'), snapshot);
      await app.start();
      const document = dom.window.document;
      assert.match(document.querySelector('#snapshotStatus').textContent, /edition error/i);
      assert.equal(document.querySelectorAll('#topStories .story-card').length, 0);
    });
  }
});

test('image failure marks the visual unavailable and retains the card title and button', async () => {
  const { dom, app } = setup(async () => new Response('{}'));
  await app.start();
  const image = dom.window.document.querySelector('#topStories .story-image');
  const card = image.closest('button');
  image.dispatchEvent(new dom.window.Event('error'));
  assert.ok(card.classList.contains('image-unavailable'));
  assert.match(card.textContent, /Image unavailable/);
  assert.match(card.textContent, /Top 1/);
  assert.equal(card.tagName, 'BUTTON');
});

test('story opens immediately, calls private endpoint, and successful body replaces summary', async () => {
  let request;
  let resolveArticle;
  const pending = new Promise(resolve => { resolveArticle = resolve; });
  const { dom, app } = setup(async (url, options) => { request = { url, options }; return pending; });
  await app.start();
  dom.window.document.querySelector('.story-card').click();
  const dialog = dom.window.document.querySelector('#readerDialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.querySelector('#readerBody').textContent, /Summary 1/);
  assert.match(dialog.querySelector('#readerStatus').textContent, /Loading full article/i);
  assert.equal(request.url, '/api/news/article');
  assert.equal(request.options.method, 'POST');

  resolveArticle(new Response(JSON.stringify({ ok: true, article: { title: 'Full title', byline: 'Writer', siteName: 'BBC', paragraphs: ['Full paragraph one.', 'Full paragraph two.'] } }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.match(dialog.querySelector('#readerBody').textContent, /Full paragraph one/);
  assert.doesNotMatch(dialog.querySelector('#readerBody').textContent, /Summary 1/);
});

test('failure retains a labelled summary and stale response cannot overwrite a newer story', async () => {
  const resolvers = [];
  const { dom, app } = setup(async () => new Promise(resolve => resolvers.push(resolve)));
  await app.start();
  const cards = dom.window.document.querySelectorAll('.story-card');
  cards[0].click();
  cards[1].click();

  resolvers[1](new Response(JSON.stringify({ ok: false, fallback: true, error: 'Full article unavailable; showing the feed summary.' }), { status: 422, headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.match(dom.window.document.querySelector('#readerStatus').textContent, /Full article unavailable/i);
  assert.match(dom.window.document.querySelector('#readerBody').textContent, /Summary 2/);

  resolvers[0](new Response(JSON.stringify({ ok: true, article: { paragraphs: ['Stale full body must not appear.'] } }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.doesNotMatch(dom.window.document.querySelector('#readerBody').textContent, /Stale full body/);
  assert.match(dom.window.document.querySelector('#readerBody').textContent, /Summary 2/);
});
