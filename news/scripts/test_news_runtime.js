'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tagName = '') {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(), children: [], dataset: {}, hidden: false, style: {},
    textContent: '', className: '',
    classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    click() { for (const listener of listeners.get('click') || []) listener({ target: this }); },
    dispatch(type) { for (const listener of listeners.get(type) || []) listener({ target: this }); },
  };
}

function walk(root) {
  return [root, ...root.children.flatMap(walk)];
}

const filters = ['All', 'Politics', 'Tech', 'Economics', 'Sports', 'Editorial'];
const topicButtons = filters.map((filter, index) => {
  const button = element('button'); button.dataset.filter = filter;
  button.setAttribute('aria-pressed', String(index === 0)); return button;
});
const leadSection = element('section');
const latestSection = element('section');
const reader = element('dialog');
reader.showModal = () => reader.setAttribute('open', '');
reader.close = () => { reader.setAttribute('open', ''); reader.dispatch('close'); };
const elements = new Map([
  ['#top-rail', element('div')], ['#story-sections', element('div')], ['#reader', reader],
  ['.lead-section', leadSection], ['.latest-section', latestSection],
]);
for (const selector of ['#reader-kicker', '#reader-title', '#reader-byline', '#reader-copy', '#reader-labels',
  '#reader-disclosure', '#reader-source', '#refresh-time', '#dateline', '#latest-heading', '.no-script']) elements.set(selector, element());

const topStories = Array.from({ length: 7 }, (_, index) => ({
  id: `top-${index}`, title: `Top story ${index}`, summary: `Top summary ${index}`, source: 'Test source',
  published: '2026-08-15T12:00:00Z', region: 'World', category: filters[(index % 3) + 1], labels: [],
  url: 'https://example.com/top', imageUrl: `https://images.example.com/${index}.jpg`,
  imageWidth: 1200, imageHeight: 675, contentStatus: 'Summary',
}));
const sectionStories = filters.slice(1, -1).map(category => ({
  id: `section-${category}`, title: `${category} section story`, summary: `${category} summary`, source: 'Test source',
  published: '2026-08-15T12:00:00Z', region: 'World', category, labels: [category],
  url: `https://example.com/${category.toLowerCase()}`,
  imageUrl: category === 'Economics' ? 'https://images.example.com/section.jpg' :
    category === 'Tech' ? 'https://user:secret@images.example.com/private.jpg' : '',
  contentStatus: 'Summary',
}));
sectionStories.push({
  ...sectionStories[0], id: 'section-odd-port', title: 'Odd port section story', summary: 'Odd port summary',
  imageUrl: 'https://images.example.com:8443/odd-port.jpg',
});
const sportsStories = [
  { id: 'rugby-label', labels: ['Rugby'], source: 'Other' },
  { id: 'rugby-england', labels: ['England Rugby'], source: 'Other' },
  { id: 'rugby-source', labels: [], source: 'BBC Rugby Union' },
  { id: 'saracens-focus', labels: ['Rugby'], source: 'Other', focus: 'Saracens' },
  { id: 'saracens-label', labels: ['Saracens'], source: 'Other' },
  { id: 'saracens-source', labels: [], source: 'Saracens' },
  ...Array.from({ length: 13 }, (_, index) => ({ id: `blue-${index}`, labels: index ? [] : ['Blue Jays'], source: 'Toronto Blue Jays', focus: index === 1 ? 'Blue Jays' : '' })),
  { id: 'leafs-focus', labels: [], source: 'Other', focus: 'Maple Leafs' },
  { id: 'leafs-label', labels: ['Maple Leafs'], source: 'Other' },
  { id: 'leafs-source', labels: [], source: 'Sportsnet Maple Leafs' },
  { id: 'near-miss', labels: ['Rugby League', 'Toronto Blue Jays prospects'], source: 'Other', focus: 'Leafs' },
].map(story => ({
  title: story.id, summary: `${story.id} summary`, published: '2026-08-15T12:00:00Z', region: 'World',
  category: 'Sports', url: `https://example.com/${story.id}`, contentStatus: 'Summary', ...story,
}));
const editorialStory = {
  id: 'editorial-long', title: 'A substantial investigation', summary: 'A concise editorial introduction.',
  body: 'First safe paragraph.\n\nSecond safe paragraph.', source: 'Essay source', publisher: 'Essay publisher',
  published: '2026-08-15T12:00:00Z', region: 'Africa', category: 'Editorial', labels: ['Editorial', 'Africa'],
  url: 'https://example.com/editorial', contentStatus: 'Freely readable article text extracted from publisher page',
  readingMinutes: 7, wordCount: 1400,
};
const fixtureEdition = { schemaVersion: 2, generatedAt: '2026-08-15T12:00:00Z', topStoryIds: topStories.map(story => story.id),
  sectionStoryIds: { Editorial: [editorialStory.id] }, stories: [...topStories, ...sectionStories, ...sportsStories, editorialStory] };
const productionMode = Boolean(process.env.NEWS_DATA_PATH);
const edition = productionMode ? JSON.parse(fs.readFileSync(process.env.NEWS_DATA_PATH, 'utf8')) : fixtureEdition;
let fetchCalled = false;
const context = {
  console, Date, Error, Intl, Map, Number, URL,
  document: {
    body: element('body'), createElement: name => element(name),
    querySelector(selector) { return elements.get(selector) || element(); },
    querySelectorAll(selector) { return selector === '.topic' ? topicButtons : []; },
  },
  fetch() { fetchCalled = true; return Promise.resolve({ ok: true, json: () => Promise.resolve(edition) }); },
};
context.globalThis = context;

function renderedCategories() {
  return elements.get('#story-sections').children.filter(child => child.className.split(' ').includes('news-section')).map(section => section.children[0].textContent);
}

function sectionList() {
  const section = elements.get('#story-sections').children.find(child => child.className.split(' ').includes('news-section'));
  return section && section.children.find(child => child.className === 'story-list');
}

function sportsButtons() {
  return walk(elements.get('#story-sections')).filter(node => node.className === 'sports-filter');
}

function openSectionStory(category, title = `${category} section story`) {
  topicButtons.find(button => button.dataset.filter === category).click();
  const list = sectionList();
  const item = list.children.find(story => story.children[1].children[0].textContent === title);
  item.children[1].children[0].click();
}

async function run() {
  const scriptPath = process.env.NEWS_JS_PATH || path.join(__dirname, '..', 'assets', 'news.js');
  assert.doesNotThrow(() => vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath }));
  assert.equal(fetchCalled, true, 'initialization starts loading');
  await new Promise(resolve => setImmediate(resolve));

  const matches = context.DailySevenSports.matchesSportsFilter;
  assert.equal(matches({ focus: 'Saracens', labels: ['Rugby'], source: 'Other' }, 'Saracens'), true);
  assert.equal(matches({ focus: '', labels: ['Saracens'], source: 'Other' }, 'Saracens'), true);
  assert.equal(matches({ focus: '', labels: [], source: 'Saracens' }, 'Saracens'), true);
  assert.equal(matches({ focus: 'Saracens', labels: ['Rugby'], source: 'Other' }, 'Rugby'), false, 'Rugby excludes Saracens');
  assert.equal(matches({ labels: ['England Rugby'], source: 'Other' }, 'Rugby'), true);
  assert.equal(matches({ labels: [], source: 'BBC Rugby Union' }, 'Rugby'), true);
  assert.equal(matches({ focus: 'Blue Jays', labels: [], source: 'Other' }, 'Blue Jays'), true);
  assert.equal(matches({ focus: '', labels: [], source: 'Toronto Blue Jays' }, 'Blue Jays'), true);
  assert.equal(matches({ focus: 'Maple Leafs', labels: [], source: 'Other' }, 'Leafs'), true, 'Leafs maps to Maple Leafs');
  assert.equal(matches({ focus: '', labels: [], source: 'Sportsnet Maple Leafs' }, 'Leafs'), true);
  for (const nearMiss of [
    { labels: ['Rugby League'], source: 'Other' }, { labels: ['Toronto Blue Jays prospects'], source: 'Other' },
    { focus: 'Leafs', labels: [], source: 'Other' },
  ]) assert.equal(['Rugby', 'Saracens', 'Blue Jays', 'Leafs'].some(filter => matches(nearMiss, filter)), false, 'no loose substring matching');

  const cards = elements.get('#top-rail').children;
  assert.equal(cards.length, 7, 'Today renders exactly seven cards');
  assert.equal(leadSection.hidden, false, 'Today shows Top 7');
  assert.equal(latestSection.hidden, true, 'Today hides latest container');
  assert.deepEqual(renderedCategories(), [], 'Today does not render section lists');

  if (productionMode) {
    topicButtons.find(button => button.dataset.filter === 'Sports').click();
    const labels = sportsButtons().map(button => button.children[0].textContent);
    assert.deepEqual(labels, ['All', 'Rugby', 'Saracens', 'Blue Jays', 'Leafs'], 'production has all five pills');
    const allSports = edition.stories.filter(story => story.category === 'Sports');
    assert.equal(sectionList().children.length, Math.min(12, allSports.length), 'production All is concise');
    for (const filter of labels.slice(1)) {
      const expectedStories = allSports.filter(story => matches(story, filter));
      const button = sportsButtons().find(candidate => candidate.dataset.sportsFilter === filter);
      assert.equal(Number(button.children[1].textContent), expectedStories.length, `${filter} production count`);
      button.click();
      assert.equal(leadSection.hidden, true, `${filter} production keeps Top 7 hidden`);
      assert.equal(sectionList().children.length, expectedStories.length, `${filter} production renders every match`);
      const titles = sectionList().children.map(item => item.children[1].children[0].textContent);
      assert.equal(titles.every(title => allSports.filter(story => story.title === title).some(story => matches(story, filter))), true,
        `${filter} production has zero mismatches`);
      if (filter === 'Blue Jays') assert.ok(titles.length > 12, 'production Blue Jays displays more than 12');
    }
    topicButtons.find(button => button.dataset.filter === 'Editorial').click();
    const editorialIds = edition.sectionStoryIds && edition.sectionStoryIds.Editorial || [];
    assert.equal(sectionList().children.length, editorialIds.length, 'production Editorial renders selected long reads');
    assert.ok(editorialIds.length >= 4, 'production Editorial is populated');
    sectionList().children[0].children[1].children[0].click();
    assert.ok(elements.get('#reader-copy').children.some(child => child.textContent.length > 100), 'production Editorial opens readable body');
    reader.dispatch('close');
    console.log('Daily Seven production Sports and Editorial DOM assertions passed');
    return;
  }

  for (const category of ['Politics', 'Tech', 'Economics']) {
    topicButtons.find(button => button.dataset.filter === category).click();
    assert.equal(leadSection.hidden, true, `${category} hides Top 7`);
    assert.equal(latestSection.hidden, false, `${category} shows latest`);
    assert.deepEqual(renderedCategories(), [category], `${category} renders only itself`);
  }

  topicButtons.find(button => button.dataset.filter === 'Editorial').click();
  assert.deepEqual(renderedCategories(), ['Editorial'], 'Editorial renders as a first-class section');
  assert.equal(sectionList().children.length, 1, 'Editorial renders qualified long reads');
  assert.match(sectionList().children[0].children[0].textContent, /7 min read · 1,400 words available/);
  sectionList().children[0].children[1].children[0].click();
  assert.deepEqual(elements.get('#reader-copy').children.map(child => child.textContent),
    ['First safe paragraph.', 'Second safe paragraph.'], 'Editorial opens its extracted body in app');
  reader.dispatch('close');

  topicButtons.find(button => button.dataset.filter === 'Sports').click();
  assert.equal(leadSection.hidden, true, 'Sports keeps Top 7 hidden');
  assert.deepEqual(sportsButtons().map(button => button.children[0].textContent), ['All', 'Rugby', 'Saracens', 'Blue Jays', 'Leafs']);
  assert.equal(sportsButtons().every(button => button.tagName === 'BUTTON' && button.type === 'button'), true, 'native buttons');
  assert.equal(sportsButtons()[0].getAttribute('aria-pressed'), 'true', 'All is default');
  assert.equal(sectionList().children.length, 12, 'All preserves concise first-12 view');

  const expected = { Rugby: 3, Saracens: 3, 'Blue Jays': 13, Leafs: 3 };
  for (const [filter, count] of Object.entries(expected)) {
    const button = sportsButtons().find(candidate => candidate.dataset.sportsFilter === filter);
    assert.equal(button.children[1].textContent, String(count), `${filter} count`);
    assert.equal(button.getAttribute('aria-label'), `${filter}, ${count} stories`, `${filter} accessible count`);
    button.click();
    assert.equal(topicButtons.find(candidate => candidate.dataset.filter === 'Sports').getAttribute('aria-pressed'), 'true', 'primary Sports remains active');
    assert.equal(leadSection.hidden, true, `${filter} keeps Top 7 hidden`);
    assert.equal(sectionList().children.length, count, `${filter} renders all matches`);
    const titles = sectionList().children.map(item => item.children[1].children[0].textContent);
    assert.equal(titles.every(title => matches(sportsStories.find(story => story.id === title), filter)), true, `${filter} has zero mismatches`);
    if (filter === 'Blue Jays') assert.ok(titles.length > 12, 'Blue Jays is not truncated');
  }

  const leafsButton = sportsButtons().find(button => button.dataset.sportsFilter === 'Leafs');
  leafsButton.click();
  sectionList().children[0].children[1].children[0].click();
  reader.dispatch('close');
  assert.equal(sportsButtons().find(button => button.dataset.sportsFilter === 'Leafs').getAttribute('aria-pressed'), 'true', 'reader close preserves filter');
  assert.equal(sectionList().children.length, 3, 'reader close preserves filtered list');

  sportsStories.filter(story => matches(story, 'Rugby')).forEach(story => { story.labels = []; story.source = 'Other'; });
  sportsButtons().find(button => button.dataset.sportsFilter === 'Rugby').click();
  assert.equal(walk(elements.get('#story-sections')).some(child => child.className === 'empty-state' && child.textContent.includes('Rugby')), true,
    'empty named filter has clear in-section message');

  openSectionStory('Economics');
  const copy = elements.get('#reader-copy');
  assert.equal(copy.children[0].tagName, 'FIGURE', 'reader image is before summary text');
  assert.equal(copy.children[1].textContent, 'Economics summary');
  const readerImage = copy.children[0].children[0];
  assert.equal(readerImage.src, 'https://images.example.com/section.jpg');
  readerImage.dispatch('error');
  assert.equal(readerImage.hidden, true); assert.equal(copy.children[0].children[1].hidden, false);

  for (const category of ['Politics', 'Tech']) {
    openSectionStory(category);
    assert.equal(elements.get('#reader-copy').children.some(child => child.tagName === 'FIGURE'), false, `${category} unsafe/missing image has no figure`);
  }
  openSectionStory('Politics', 'Odd port section story');
  assert.equal(elements.get('#reader-copy').children.some(child => child.tagName === 'FIGURE'), false, 'odd-port image has no figure');
  topicButtons[0].click();
  assert.equal(leadSection.hidden, false); assert.equal(latestSection.hidden, true);
  assert.deepEqual(renderedCategories(), [], 'Today restores only the seven');
  console.log('Daily Seven Sports filters and regression runtime tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
