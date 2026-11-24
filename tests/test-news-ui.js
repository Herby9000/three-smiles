'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const edition = JSON.parse(fs.readFileSync('news/data/news.json', 'utf8'));
const html = fs.readFileSync('news/index.html', 'utf8');
const script = fs.readFileSync('news/assets/news.js', 'utf8');
const styles = fs.readFileSync('news/assets/news.css', 'utf8');
const editorialStyles = fs.readFileSync('news/assets/editorial.css', 'utf8');

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

function setup(snapshot = edition, articleResponse = {
  status: 200,
  body: {
    ok: true,
    article: {
      title: 'Extracted BBC title',
      byline: 'BBC Reporter',
      siteName: 'BBC',
      paragraphs: ['First extracted BBC paragraph.', 'Second extracted BBC paragraph.']
    }
  }
}) {
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
    if (url === '/api/news/article') {
      return new Response(JSON.stringify(articleResponse.body), {
        status: articleResponse.status,
        headers: { 'content-type': 'application/json' }
      });
    }
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

test('BBC Top Stories is the final Today-only content section and preserves every safe headline in order', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = Array.from({ length: 9 }, (_, index) => ({
    title: `BBC headline ${index + 1}`,
    url: `https://www.bbc.com/news/articles/story-${index + 1}`
  }));
  const { dom } = setup(snapshot);
  await tick();
  const document = dom.window.document;
  const section = document.querySelector('#bbc-top-stories');
  const buttons = [...section.querySelectorAll('button')];

  assert.equal(document.querySelectorAll('#top-rail .story-card').length, 7, 'Top 7 remains unchanged');
  assert.equal(document.querySelector('main').lastElementChild, section, 'BBC is the final content section before the footer');
  assert.equal(section.hidden, false, 'BBC headlines are shown on Today');
  assert.deepEqual(buttons.map(button => button.textContent), snapshot.bbcTopStories.map(story => story.title), 'snapshot order is preserved without a limit');
  assert.ok(buttons.every(button => button.tagName === 'BUTTON' && button.type === 'button' && button.textContent.startsWith('BBC headline')));
  assert.ok(buttons.every(button => /read .* in app/i.test(button.getAttribute('aria-label'))));
  assert.ok([...section.querySelectorAll('.bbc-attribution')].every(label => label.textContent === 'BBC'));

  document.querySelector('[data-filter="Politics"]').click();
  assert.equal(section.hidden, true, 'BBC headlines are hidden on other tabs');
  document.querySelector('[data-filter="All"]').click();
  assert.equal(section.hidden, false, 'BBC headlines return on Today');
});

test('BBC Top Stories tolerates an absent feed and only renders verified HTTPS BBC hosts', async () => {
  const oldSnapshot = structuredClone(edition);
  delete oldSnapshot.bbcTopStories;
  const oldEdition = setup(oldSnapshot);
  await tick();
  assert.equal(oldEdition.dom.window.document.querySelector('#bbc-top-stories').hidden, true);
  assert.equal(oldEdition.dom.window.document.querySelectorAll('#bbc-top-stories button').length, 0);

  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [
    { title: 'Safe BBC.com', url: 'https://www.bbc.com/news/articles/safe' },
    { title: 'Safe BBC.co.uk', url: 'https://www.bbc.co.uk/news/articles/safe' },
    { title: 'Plain HTTP', url: 'http://www.bbc.com/news/articles/unsafe' },
    { title: 'Deceptive host', url: 'https://www.bbc.com.example.test/news' },
    { title: 'Credential URL', url: 'https://user@www.bbc.com/news' },
    { title: 'Non-BBC host', url: 'https://example.com/news' }
  ];
  const { dom } = setup(snapshot);
  await tick();
  const buttons = [...dom.window.document.querySelectorAll('#bbc-top-stories button')];
  assert.deepEqual(buttons.map(button => button.textContent), ['Safe BBC.com', 'Safe BBC.co.uk']);
  assert.ok(buttons.every(button => !button.hasAttribute('formaction')));
});

test('BBC headline opens in app with its snapshot description, then requests and renders the extracted body', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [{
    title: 'BBC reader fixture',
    description: 'Canonical BBC snapshot description.',
    url: 'https://www.bbc.com/news/articles/reader-fixture'
  }];
  const { dom, requests } = setup(snapshot);
  await tick();
  const document = dom.window.document;
  const button = document.querySelector('#bbc-top-stories button');

  button.click();
  assert.equal(document.querySelector('#reader').open, true, 'headline tap stays in the app');
  assert.equal(document.querySelector('#reader-title').textContent, snapshot.bbcTopStories[0].title);
  assert.equal(document.querySelector('#reader-copy').textContent, snapshot.bbcTopStories[0].description, 'description is the immediate excerpt');
  assert.equal(dom.window.location.href, 'https://three-smiles.herbyprojects.com/news/');
  assert.equal(requests[1].url, '/api/news/article');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[1].options.body), { url: snapshot.bbcTopStories[0].url });

  await tick();
  assert.equal(document.querySelector('#reader-title').textContent, 'Extracted BBC title');
  assert.deepEqual([...document.querySelectorAll('#reader-copy p')].map(paragraph => paragraph.textContent),
    ['First extracted BBC paragraph.', 'Second extracted BBC paragraph.']);
  assert.match(document.querySelector('#reader-disclosure').textContent, /extracted for private reading/i);
  assert.equal(document.querySelector('#reader-source').href, snapshot.bbcTopStories[0].url, 'only the optional source control links out');
});

test('BBC reader retains the snapshot description when extraction is unavailable', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [{
    title: 'BBC fallback fixture',
    description: 'Keep this BBC summary visible.',
    url: 'https://www.bbc.co.uk/news/articles/fallback-fixture'
  }];
  const fallback = {
    status: 422,
    body: { ok: false, fallback: true, error: 'Full article unavailable; showing the feed summary.' }
  };
  const { dom } = setup(snapshot, fallback);
  await tick();
  const document = dom.window.document;

  document.querySelector('#bbc-top-stories button').click();
  await tick();
  assert.equal(document.querySelector('#reader-copy').textContent, snapshot.bbcTopStories[0].description);
  assert.match(document.querySelector('#reader-disclosure').textContent, /unavailable.*showing the feed summary/i);
  assert.equal(document.querySelector('#reader-source').hidden, false);
});

test('BBC feed images are validated, paired with headlines and retained as reader fallback', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [
    {
      title: 'BBC photographed fixture',
      description: 'A feed-supplied summary.',
      url: 'https://www.bbc.com/news/articles/photographed-fixture',
      image: 'https://ichef.bbci.co.uk/news/1024/cpsprodpb/fixture.jpg',
      imageWidth: 1024,
      imageHeight: 576,
      imageAlt: 'Reporter at the scene'
    },
    {
      title: 'BBC invalid image fixture',
      url: 'https://www.bbc.com/news/articles/invalid-image-fixture',
      image: 'http://ichef.bbci.co.uk/news/unsafe.jpg',
      imageWidth: 1024,
      imageHeight: 576
    }
  ];
  const articleWithoutImages = {
    status: 200,
    body: { ok: true, article: { title: 'Extracted', siteName: 'BBC', paragraphs: ['First full paragraph.', 'Second full paragraph.'] } }
  };
  const { dom } = setup(snapshot, articleWithoutImages);
  await tick();
  const document = dom.window.document;
  const items = document.querySelectorAll('.bbc-headline');

  assert.equal(items.length, 2, 'every BBC item remains present and ordered');
  assert.equal(items[0].querySelector('img').src, snapshot.bbcTopStories[0].image);
  assert.equal(items[0].querySelector('img').alt, snapshot.bbcTopStories[0].imageAlt);
  assert.equal(items[1].querySelector('img'), null, 'an unvalidated image never masquerades as a news photo');

  items[0].querySelector('button').click();
  await tick();
  const fallback = document.querySelector('.reader-lead-image img');
  assert.equal(fallback.src, snapshot.bbcTopStories[0].image, 'validated snapshot image survives extraction without imagery');
  assert.equal(fallback.alt, snapshot.bbcTopStories[0].imageAlt);
});

test('BBC extracted lead and inline photos render in publisher order through the safe reader pipeline', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [{
    title: 'BBC image reader fixture',
    description: 'Immediate feed summary.',
    url: 'https://www.bbc.co.uk/news/articles/image-reader-fixture',
    image: 'https://ichef.bbci.co.uk/news/1024/cpsprodpb/snapshot.jpg',
    imageWidth: 1024,
    imageHeight: 576
  }];
  const extracted = {
    status: 200,
    body: {
      ok: true,
      article: {
        title: 'BBC image reader fixture',
        siteName: 'BBC',
        paragraphs: ['Opening extracted paragraph.', 'Closing extracted paragraph.'],
        leadImage: { url: 'https://ichef.bbci.co.uk/news/1200/cpsprodpb/lead.jpg', width: 1200, height: 675, alt: 'Lead scene' },
        blocks: [
          { type: 'paragraph', text: 'Opening extracted paragraph.' },
          { type: 'image', url: 'https://ichef.bbci.co.uk/news/1200/cpsprodpb/inline.jpg', width: 1200, height: 800, alt: 'Inline scene', caption: 'A supplied BBC caption' },
          { type: 'paragraph', text: 'Closing extracted paragraph.' }
        ]
      }
    }
  };
  const { dom } = setup(snapshot, extracted);
  await tick();
  const document = dom.window.document;

  document.querySelector('#bbc-top-stories button').click();
  await tick();
  assert.equal(document.querySelector('.reader-lead-image img').src, extracted.body.article.leadImage.url, 'real extracted lead replaces snapshot fallback');
  assert.deepEqual([...document.querySelectorAll('#reader-copy > *')].map(node => node.classList.contains('reader-image') ? 'image' : node.textContent),
    ['image', 'Opening extracted paragraph.', 'image', 'Closing extracted paragraph.']);
  assert.equal(document.querySelector('.reader-inline-image figcaption').textContent, 'A supplied BBC caption');
});

test('BBC photos without metadata use natural dimensions and retain the verified feed fallback', async () => {
  const snapshot = structuredClone(edition);
  snapshot.bbcTopStories = [{
    title: 'BBC metadata-free image fixture',
    description: 'Immediate feed summary.',
    url: 'https://www.bbc.com/news/articles/metadata-free-image-fixture',
    image: 'https://ichef.bbci.co.uk/news/1024/cpsprodpb/snapshot.jpg',
    imageWidth: 1024,
    imageHeight: 576,
    imageAlt: 'Verified feed fallback'
  }];
  const extracted = {
    status: 200,
    body: {
      ok: true,
      article: {
        title: 'BBC metadata-free image fixture',
        siteName: 'BBC',
        paragraphs: ['Opening extracted paragraph.', 'Closing extracted paragraph.'],
        leadImage: { url: 'https://ichef.bbci.co.uk/news/1200/cpsprodpb/lead-no-size.jpg', alt: 'Lead without metadata' },
        blocks: [
          { type: 'paragraph', text: 'Opening extracted paragraph.' },
          { type: 'image', url: 'https://ichef.bbci.co.uk/news/1200/cpsprodpb/inline-large.jpg', alt: 'Large inline without metadata' },
          { type: 'image', url: 'https://ichef.bbci.co.uk/news/480/cpsprodpb/inline-small.jpg', alt: 'Small inline without metadata' },
          { type: 'paragraph', text: 'Closing extracted paragraph.' }
        ]
      }
    }
  };
  const setNaturalSizeAndLoad = (dom, image, width, height) => {
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: width },
      naturalHeight: { configurable: true, value: height }
    });
    image.dispatchEvent(new dom.window.Event('load'));
  };

  const lowResolution = setup(snapshot, extracted);
  await tick();
  lowResolution.dom.window.document.querySelector('#bbc-top-stories button').click();
  await tick();
  const lowDocument = lowResolution.dom.window.document;
  const lead = lowDocument.querySelector('.reader-lead-image img');
  assert.equal(lead.src, extracted.body.article.leadImage.url, 'the live API shape is accepted before intrinsic size validation');
  const inline = [...lowDocument.querySelectorAll('.reader-inline-image img')];
  assert.equal(inline.length, 2, 'metadata-free inline candidates are conditionally rendered');
  setNaturalSizeAndLoad(lowResolution.dom, inline[0], 1200, 800);
  setNaturalSizeAndLoad(lowResolution.dom, inline[1], 480, 320);
  assert.deepEqual([...lowDocument.querySelectorAll('.reader-inline-image img')].map(image => image.src), [inline[0].src],
    'only an intrinsically large inline photo remains');
  setNaturalSizeAndLoad(lowResolution.dom, lead, 800, 450);
  assert.equal(lowDocument.querySelector('.reader-lead-image img').src, snapshot.bbcTopStories[0].image,
    'a low-resolution extracted lead restores the verified feed photo');

  const failedLoad = setup(snapshot, extracted);
  await tick();
  failedLoad.dom.window.document.querySelector('#bbc-top-stories button').click();
  await tick();
  failedLoad.dom.window.document.querySelector('.reader-lead-image img')
    .dispatchEvent(new failedLoad.dom.window.Event('error'));
  assert.equal(failedLoad.dom.window.document.querySelector('.reader-lead-image img').src, snapshot.bbcTopStories[0].image,
    'an extracted lead load error restores the verified feed photo');
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

test('Today promotes the first ordered Top 7 story as a photo-led lead and section lists use verified feed photos', async () => {
  const { dom } = setup();
  await tick();
  const document = dom.window.document;
  const cards = [...document.querySelectorAll('#top-rail .story-card')];
  const firstId = edition.topStoryIds[0];
  const firstStory = edition.stories.find(story => story.id === firstId);

  assert.equal(cards.length, 7);
  assert.ok(cards[0].classList.contains('story-card-lead'));
  assert.equal(cards[0].querySelector('h3').textContent, firstStory.title, 'Top 7 order remains unchanged');
  assert.equal(cards[0].querySelector('img').loading, 'eager');
  assert.ok(cards.slice(1).every(card => card.classList.contains('story-card-secondary')));

  document.querySelector('[data-filter="Politics"]').click();
  const pictured = [...document.querySelectorAll('.list-story.has-story-image')];
  assert.ok(pictured.length > 0, 'feed-supplied section imagery is visibly used');
  assert.ok(pictured.every(card => {
    const image = card.querySelector('img');
    return image && image.src.startsWith('https:') && Number(image.width) >= 960 && Number(image.height) >= 540;
  }));
});

test('literary magazine system keeps warm paper, oxblood accents, original wordmark and responsive layouts', () => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.equal(document.querySelector('.wordmark')?.textContent.trim(), 'The Daily Seven');
  assert.match(styles, /--paper:\s*#[a-f\d]{6}/i);
  assert.match(styles, /--oxblood:\s*#[a-f\d]{6}/i);
  assert.match(styles, /\.wordmark\{/);
  assert.match(styles, /\.story-card-lead\{/);
  assert.match(styles, /@media\(max-width:750px\)/);
  assert.match(styles + editorialStyles, /\.bbc-headline-media\{/);
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