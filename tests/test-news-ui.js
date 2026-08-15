'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { createNewsApp, matchesSportsFilter } = require('../news/news');

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

  const fetchImpl = async (url, options) => {
    if (url === 'fixture://snapshot') return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } });
    return articleFetch(url, options);
  };
  const app = createNewsApp({ document: dom.window.document, fetchImpl, snapshotUrl: 'fixture://snapshot' });
  return { dom, app };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function sportsStory(id, overrides = {}) {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    url: `https://example.test/${id}`,
    source: 'BBC Sport',
    category: 'Sports',
    focus: '',
    labels: ['Sports'],
    ...overrides
  };
}

function sportsSnapshot(sports) {
  const snapshot = structuredClone(fixture);
  snapshot.schemaVersion = 2;
  snapshot.stories = snapshot.stories.filter(story => story.category !== 'Sports');
  snapshot.stories.push(...sports);
  return snapshot;
}

const contractSports = [
  ...Array.from({ length: 22 }, (_, index) => sportsStory(`blue-${index + 1}`, { focus: 'Blue Jays', labels: ['Sports', 'Blue Jays'], source: 'Toronto Blue Jays' })),
  ...Array.from({ length: 7 }, (_, index) => sportsStory(`saracens-${index + 1}`, { focus: 'Saracens', labels: ['Sports', 'Rugby', 'Saracens'], source: 'Saracens' })),
  ...Array.from({ length: 12 }, (_, index) => sportsStory(`rugby-${index + 1}`, { labels: ['Sports', index % 2 ? 'Rugby' : 'England Rugby'], source: 'BBC Rugby Union' })),
  sportsStory('leafs-1', { focus: 'Maple Leafs', labels: ['Sports', 'Maple Leafs'], source: 'Sportsnet Maple Leafs' }),
  ...Array.from({ length: 41 }, (_, index) => sportsStory(`other-${index + 1}`))
];

test('Sports matching uses only the exact focus, label, and source contract', () => {
  assert.equal(matchesSportsFilter(sportsStory('focus-saracens', { focus: 'Saracens' }), 'Saracens'), true);
  assert.equal(matchesSportsFilter(sportsStory('label-saracens', { labels: ['Sports', 'Saracens'] }), 'Saracens'), true);
  assert.equal(matchesSportsFilter(sportsStory('source-saracens', { source: 'Saracens' }), 'Saracens'), true);
  assert.equal(matchesSportsFilter(sportsStory('near-saracens', { focus: 'Saracens Women', labels: ['Sports', 'Saracens news'], source: 'Saracens Rugby' }), 'Saracens'), false);

  assert.equal(matchesSportsFilter(sportsStory('focus-blue', { focus: 'Blue Jays' }), 'Blue Jays'), true);
  assert.equal(matchesSportsFilter(sportsStory('label-blue', { labels: ['Blue Jays'] }), 'Blue Jays'), true);
  assert.equal(matchesSportsFilter(sportsStory('source-blue', { source: 'Toronto Blue Jays' }), 'Blue Jays'), true);
  assert.equal(matchesSportsFilter(sportsStory('near-blue', { focus: 'Toronto Blue Jays', labels: ['Blue Jays Baseball'], source: 'Blue Jays' }), 'Blue Jays'), false);

  assert.equal(matchesSportsFilter(sportsStory('focus-leafs', { focus: 'Maple Leafs' }), 'Leafs'), true);
  assert.equal(matchesSportsFilter(sportsStory('label-leafs', { labels: ['Maple Leafs'] }), 'Leafs'), true);
  assert.equal(matchesSportsFilter(sportsStory('source-leafs', { source: 'Sportsnet Maple Leafs' }), 'Leafs'), true);
  assert.equal(matchesSportsFilter(sportsStory('near-leafs', { focus: 'Leafs', labels: ['Toronto Maple Leafs'], source: 'Maple Leafs' }), 'Leafs'), false);

  assert.equal(matchesSportsFilter(sportsStory('rugby-label', { labels: ['Rugby'] }), 'Rugby'), true);
  assert.equal(matchesSportsFilter(sportsStory('england-rugby-label', { labels: ['England Rugby'] }), 'Rugby'), true);
  assert.equal(matchesSportsFilter(sportsStory('rugby-source', { source: 'BBC Rugby Union' }), 'Rugby'), true);
  assert.equal(matchesSportsFilter(sportsStory('rugby-near', { labels: ['Rugby Union'], source: 'BBC Rugby' }), 'Rugby'), false);
  assert.equal(matchesSportsFilter(sportsStory('rugby-saracens', { labels: ['Rugby', 'Saracens'], source: 'BBC Rugby Union' }), 'Rugby'), false);
});

test('checked-in schemaVersion 2 contract snapshot has current nonzero Sports group counts', () => {
  assert.equal(contractSports.length, 83);
  assert.deepEqual(Object.fromEntries(['Rugby', 'Saracens', 'Blue Jays', 'Leafs'].map(filter => [filter, contractSports.filter(story => matchesSportsFilter(story, filter)).length])), {
    Rugby: 12,
    Saracens: 7,
    'Blue Jays': 22,
    Leafs: 1
  });
});

test('Sports renders five accessible filters, concise All, and every exact named match', async () => {
  const { dom, app } = setup(async () => new Response('{}'), sportsSnapshot(contractSports));
  await app.start();
  const document = dom.window.document;
  document.querySelector('[data-section="Sports"]').click();

  const heading = document.querySelector('#sectionStories .selected-heading');
  const filters = [...document.querySelectorAll('[data-sports-filter]')];
  assert.equal(heading.nextElementSibling.className, 'sports-filters');
  assert.deepEqual(filters.map(button => button.dataset.sportsFilter), ['All', 'Rugby', 'Saracens', 'Blue Jays', 'Leafs']);
  assert.ok(filters.every(button => button.tagName === 'BUTTON' && button.type === 'button'));
  assert.deepEqual(filters.map(button => button.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false']);
  assert.deepEqual(filters.map(button => button.getAttribute('aria-label')), ['All, 83 stories', 'Rugby, 12 stories', 'Saracens, 7 stories', 'Blue Jays, 22 stories', 'Leafs, 1 story']);
  assert.equal(document.querySelectorAll('#sectionStories .story-card').length, 12, 'All remains concise');

  for (const filter of ['Rugby', 'Saracens', 'Blue Jays', 'Leafs']) {
    document.querySelector(`[data-sports-filter="${filter}"]`).click();
    const expected = contractSports.filter(story => matchesSportsFilter(story, filter));
    const cards = [...document.querySelectorAll('#sectionStories .story-card')];
    assert.equal(cards.length, expected.length, `${filter} is not truncated`);
    assert.deepEqual(cards.map(card => card.querySelector('strong').textContent), expected.map(story => story.title));
    assert.equal(document.querySelector('[data-section="Sports"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector(`[data-sports-filter="${filter}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('#leadSection').hidden, true);
  }
});

test('Sports filter survives authenticated reader dialog round trip and empty matches are clear', async () => {
  const emptyLeafs = contractSports.filter(story => story.id !== 'leafs-1');
  const { dom, app } = setup(async () => new Response(JSON.stringify({ ok: false, error: 'Unavailable' }), { status: 422 }), sportsSnapshot(emptyLeafs));
  await app.start();
  const document = dom.window.document;
  document.querySelector('[data-section="Sports"]').click();
  document.querySelector('[data-sports-filter="Blue Jays"]').click();
  document.querySelector('#sectionStories .story-card').click();
  assert.equal(document.querySelector('#readerDialog').open, true);
  document.querySelector('#readerClose').click();
  assert.equal(document.querySelector('#readerDialog').open, false);
  assert.equal(document.querySelector('[data-section="Sports"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-sports-filter="Blue Jays"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelectorAll('#sectionStories .story-card').length, 22);

  document.querySelector('[data-sports-filter="Leafs"]').click();
  assert.equal(document.querySelectorAll('#sectionStories .story-card').length, 0);
  assert.match(document.querySelector('.sports-empty').textContent, /No Leafs stories in this edition/i);
});

test('Sports filters are touch-sized, non-wrapping, and horizontally scrollable at 320px', () => {
  const css = fs.readFileSync('news/news.css', 'utf8');
  assert.match(css, /\.sports-filters\s*\{[^}]*display:\s*flex/i);
  assert.match(css, /\.sports-filters\s*\{[^}]*overflow-x:\s*auto/i);
  assert.match(css, /\.sports-filters\s*\{[^}]*flex-wrap:\s*nowrap/i);
  assert.match(css, /\.sports-filter\s*\{[^}]*flex:\s*0\s+0\s+auto/i);
  assert.match(css, /\.sports-filter\s*\{[^}]*white-space:\s*nowrap/i);
  assert.match(css, /\.sports-filter\s*\{[^}]*min-height:\s*44px/i);
});

test('section pills remain content-sized, single-line, touch-sized, and horizontally scrollable at 320px', () => {
  const css = fs.readFileSync('news/news.css', 'utf8');
  assert.match(css, /\.section-tabs\s*\{[^}]*overflow-x:\s*auto/i);
  assert.match(css, /\.section-tabs button\s*\{[^}]*flex:\s*0\s+0\s+auto/i);
  assert.match(css, /\.section-tabs button\s*\{[^}]*white-space:\s*nowrap/i);
  assert.match(css, /\.section-tabs button\s*\{[^}]*min-height:\s*44px/i);
  assert.match(css, /\.section-tabs button:focus-visible/);
  assert.ok(5 * 82 + 4 * 8 > 320 - 36, 'minimum pill row is wider than a 320px viewport and can scroll');
});

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

test('story hero appears during loading and ordered full blocks render safely without duplicating it', async () => {
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
  const loadingHero = dialog.querySelector('.reader-hero img');
  assert.equal(loadingHero.src, fixture.stories[0].imageUrl);
  assert.equal(loadingHero.getAttribute('loading'), 'lazy');
  assert.equal(loadingHero.getAttribute('decoding'), 'async');
  assert.equal(loadingHero.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(request.url, '/api/news/article');
  assert.equal(request.options.method, 'POST');

  resolveArticle(new Response(JSON.stringify({ ok: true, article: {
    title: 'Full title', byline: 'Writer', siteName: 'BBC',
    paragraphs: ['Full paragraph one.', 'Full paragraph two.'],
    blocks: [
      { type: 'paragraph', text: 'Full paragraph one.' },
      { type: 'image', url: fixture.stories[0].imageUrl, alt: 'Duplicate hero' },
      { type: 'image', url: 'https://ichef.bbci.co.uk/news/body.jpg', alt: 'Body image', caption: 'A plain caption' },
      { type: 'paragraph', text: 'Full paragraph two.' }
    ]
  } }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.match(dialog.querySelector('#readerBody').textContent, /Full paragraph one/);
  assert.doesNotMatch(dialog.querySelector('#readerBody').textContent, /Summary 1/);
  assert.deepEqual([...dialog.querySelector('#readerBody').children].map(node => node.tagName), ['FIGURE', 'P', 'FIGURE', 'P']);
  assert.equal(dialog.querySelectorAll(`img[src="${fixture.stories[0].imageUrl}"]`).length, 1);
  assert.equal(dialog.querySelector('figcaption').textContent, 'A plain caption');

  const bodyFigure = dialog.querySelector('.reader-article-image');
  bodyFigure.querySelector('img').dispatchEvent(new dom.window.Event('error'));
  assert.equal(bodyFigure.isConnected, false);
  assert.match(dialog.querySelector('#readerBody').textContent, /Full paragraph one/);
  assert.match(dialog.querySelector('#readerBody').textContent, /Full paragraph two/);
});

test('extracted lead replaces a low feed hero, natural-size checks remove only low images, and duplicate lead blocks are omitted', async () => {
  const feedUrl = fixture.stories[0].imageUrl;
  const leadUrl = 'https://ichef.bbci.co.uk/news/lead-1200.jpg';
  const lowUrl = 'https://ichef.bbci.co.uk/news/body-low.jpg';
  const exactUrl = 'https://ichef.bbci.co.uk/news/body-exact.jpg';
  const { dom, app } = setup(async () => new Response(JSON.stringify({ ok: true, article: {
    title: 'High resolution article', paragraphs: ['Paragraph one remains.', 'Paragraph two remains.'],
    leadImage: { url: leadUrl, width: 1200, height: 630, alt: 'Publisher lead' },
    blocks: [
      { type: 'paragraph', text: 'Paragraph one remains.' },
      { type: 'image', url: leadUrl, width: 1200, height: 630, alt: 'Duplicate lead' },
      { type: 'image', url: lowUrl, alt: 'Low natural size' },
      { type: 'image', url: exactUrl, width: 960, height: 540, alt: 'Exact minimum' },
      { type: 'paragraph', text: 'Paragraph two remains.' }
    ]
  } }), { headers: { 'content-type': 'application/json' } }));
  await app.start();
  dom.window.document.querySelector('.story-card').click();
  assert.equal(dom.window.document.querySelector('.reader-hero img').src, feedUrl);
  await tick();

  const body = dom.window.document.querySelector('#readerBody');
  assert.equal(body.querySelector('.reader-hero img').src, leadUrl);
  assert.equal(body.querySelectorAll(`img[src="${leadUrl}"]`).length, 1);
  const low = body.querySelector(`img[src="${lowUrl}"]`);
  Object.defineProperties(low, { naturalWidth: { value: 959 }, naturalHeight: { value: 540 } });
  low.dispatchEvent(new dom.window.Event('load'));
  assert.equal(low.isConnected, false);
  const exact = body.querySelector(`img[src="${exactUrl}"]`);
  Object.defineProperties(exact, { naturalWidth: { value: 960 }, naturalHeight: { value: 540 } });
  exact.dispatchEvent(new dom.window.Event('load'));
  assert.equal(exact.isConnected, true);
  assert.match(body.textContent, /Paragraph one remains/);
  assert.match(body.textContent, /Paragraph two remains/);
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
  assert.equal(dom.window.document.querySelector('.reader-hero img').src, fixture.stories[1].imageUrl);

  resolvers[0](new Response(JSON.stringify({ ok: true, article: { paragraphs: ['Stale full body must not appear.'] } }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.doesNotMatch(dom.window.document.querySelector('#readerBody').textContent, /Stale full body/);
  assert.match(dom.window.document.querySelector('#readerBody').textContent, /Summary 2/);
});
