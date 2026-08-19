(() => {
  'use strict';
  const editionUrl = 'https://herby9000.github.io/herbyprojects/news/data/news.json';
  const state = { data: null, filter: 'All', sportsFilter: 'All' };
  const sportsFilterNames = ['All', 'Rugby', 'Saracens', 'Blue Jays', 'Leafs'];
  const $ = selector => document.querySelector(selector);
  const rail = $('#top-rail');
  const leadSection = $('.lead-section');
  const latestSection = $('.latest-section');
  const sections = $('#story-sections');
  const reader = $('#reader');
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  function safeDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'Publication time unavailable' : formatter.format(date);
  }
  function el(name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function lengthLabel(story) {
    const minutes = Number(story.readingMinutes); const words = Number(story.wordCount);
    if (Number.isInteger(minutes) && minutes > 0 && Number.isInteger(words) && words >= 0) return `${minutes} min read · ${words.toLocaleString()} words available`;
    return 'Length unavailable';
  }
  function meta(story) { return `${story.publisher || story.source} · ${safeDate(story.published)} · ${story.region} · ${lengthLabel(story)}`; }
  function matchesSportsFilter(story, filter) {
    if (filter === 'All') return story.category === 'Sports';
    const labels = Array.isArray(story.labels) ? story.labels : [];
    const saracens = story.focus === 'Saracens' || labels.includes('Saracens') || story.source === 'Saracens';
    if (filter === 'Saracens') return saracens;
    if (filter === 'Blue Jays') return story.focus === 'Blue Jays' || labels.includes('Blue Jays') || story.source === 'Toronto Blue Jays';
    if (filter === 'Leafs') return story.focus === 'Maple Leafs' || labels.includes('Maple Leafs') || story.source === 'Sportsnet Maple Leafs';
    if (filter === 'Rugby') return !saracens && (labels.includes('Rugby') || labels.includes('England Rugby') || story.source === 'BBC Rugby Union');
    return false;
  }
  function safeSourceUrl(value) {
    try {
      const url = new URL(value);
      const normalPort = !url.port || (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && normalPort ? url.href : '';
    } catch (_) { return ''; }
  }
  function safeImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : '';
    } catch (_) { return ''; }
  }
  function verifiedImageSize(story) {
    const width = Number(story.imageWidth); const height = Number(story.imageHeight);
    return Number.isInteger(width) && Number.isInteger(height) && width >= 960 && height >= 540 ? [width, height] : null;
  }
  function openReader(story) {
    $('#reader-kicker').textContent = `${story.category} · ${story.region}`;
    $('#reader-title').textContent = story.title;
    $('#reader-byline').textContent = meta(story);
    const copy = $('#reader-copy');
    const body = story.body || story.summary;
    const prose = String(body || '').split(/\n{2,}/).filter(Boolean).map(paragraph => el('p', '', paragraph));
    const imageUrl = safeImageUrl(story.imageUrl);
    if (imageUrl) {
      const figure = el('figure', 'reader-image');
      const image = el('img', 'reader-image-media');
      const size = verifiedImageSize(story) || [640, 360];
      image.src = imageUrl; image.alt = ''; image.width = size[0]; image.height = size[1];
      image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      const unavailable = el('figcaption', 'reader-image-status', 'Publisher image unavailable');
      unavailable.hidden = true;
      image.addEventListener('error', () => {
        image.hidden = true; unavailable.hidden = false; figure.classList.add('image-unavailable');
      });
      figure.append(image, unavailable);
      copy.replaceChildren(figure, ...prose);
    } else {
      copy.replaceChildren(...prose);
    }
    const storyLabels = Array.isArray(story.labels) ? story.labels : [story.category, story.region];
    const labels = $('#reader-labels'); labels.replaceChildren(...storyLabels.map(label => el('span', '', label)));
    $('#reader-disclosure').textContent = `${story.contentStatus}. This reader never fabricates missing article text or embeds a publisher page.`;
    const source = $('#reader-source');
    const sourceUrl = safeSourceUrl(story.url);
    source.hidden = !sourceUrl;
    if (sourceUrl) source.href = sourceUrl;
    source.setAttribute('aria-label', `Optional: continue reading ${story.title} at ${story.source} (opens new tab)`);
    if (typeof reader.showModal === 'function') reader.showModal(); else reader.setAttribute('open', '');
    document.body.classList.add('reader-open');
  }
  reader.addEventListener('close', () => document.body.classList.remove('reader-open'));
  reader.addEventListener('click', event => { if (event.target === reader) reader.close(); });

  function storyButton(story, compact = false) {
    const button = el('button', compact ? '' : 'read-button', compact ? story.title : 'Read in app');
    button.type = 'button'; button.addEventListener('click', () => openReader(story));
    return button;
  }
  function renderTop(stories) {
    rail.replaceChildren();
    stories.forEach((story, index) => {
      const card = el('article', 'story-card');
      const frame = el('div', 'story-image-frame');
      const image = el('img', 'story-image');
      const size = verifiedImageSize(story);
      image.src = safeImageUrl(story.imageUrl); image.alt = ''; image.width = size[0]; image.height = size[1];
      image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      const unavailable = el('p', 'image-status', 'Publisher image unavailable'); unavailable.hidden = true;
      image.addEventListener('error', () => {
        image.hidden = true; unavailable.hidden = false; card.classList.add('image-unavailable');
      });
      frame.append(image, unavailable);
      card.append(frame, el('p', 'card-number', String(index + 1).padStart(2, '0')),
        el('p', 'story-meta', meta(story)), el('h3', '', story.title), el('p', 'dek', story.summary), storyButton(story));
      rail.append(card);
    });
    rail.setAttribute('aria-busy', 'false');
  }
  function renderSections(stories) {
    sections.replaceChildren();
    const categories = state.filter === 'All' ? [] : [state.filter];
    categories.forEach(category => {
      const allCategoryStories = stories.filter(story => story.category === category);
      const selectedIds = state.data.sectionStoryIds && state.data.sectionStoryIds[category];
      const selected = Array.isArray(selectedIds)
        ? selectedIds.map(id => stories.find(story => story.id === id)).filter(Boolean)
        : allCategoryStories.slice(0, 12);
      const categoryStories = category === 'Sports'
        ? (state.sportsFilter === 'All' ? selected : allCategoryStories.filter(story => matchesSportsFilter(story, state.sportsFilter)))
        : selected;
      const wrapper = el('section', category === 'Editorial' ? 'news-section editorial-section' : 'news-section');
      wrapper.append(el('h3', 'news-section-title', category));
      if (category === 'Sports') {
        const row = el('div', 'sports-filters');
        row.setAttribute('aria-label', 'Filter Sports stories');
        sportsFilterNames.forEach(filter => {
          const count = filter === 'All' ? allCategoryStories.length : allCategoryStories.filter(story => matchesSportsFilter(story, filter)).length;
          const button = el('button', 'sports-filter');
          button.type = 'button'; button.dataset.sportsFilter = filter;
          const active = state.sportsFilter === filter;
          button.setAttribute('aria-pressed', String(active));
          button.setAttribute('aria-label', `${filter}, ${count} ${count === 1 ? 'story' : 'stories'}`);
          const label = el('span', 'sports-filter-label', filter);
          const badge = el('span', 'sports-filter-count', String(count)); badge.setAttribute('aria-hidden', 'true');
          button.append(label, badge);
          button.addEventListener('click', () => { state.sportsFilter = filter; renderSections(stories); });
          row.append(button);
        });
        wrapper.append(row);
      }
      const list = el('div', 'story-list');
      categoryStories.forEach(story => {
        const item = el('article', category === 'Editorial' ? 'list-story editorial-story' : 'list-story');
        const title = el('h3'); title.append(storyButton(story, true));
        item.append(el('p', 'story-meta', meta(story)), title,
          el('p', 'list-dek', story.summary), el('p', 'labels', (story.labels || []).join(' · ')));
        list.append(item);
      });
      if (categoryStories.length) wrapper.append(list);
      else wrapper.append(el('p', 'empty-state', category === 'Editorial'
        ? 'Editorial feeds are temporarily unavailable or no articles met the long-read standard. The next refresh will try again.'
        : `No ${state.sportsFilter} stories are available in this edition.`));
      sections.append(wrapper);
    });
    if (state.filter !== 'All' && !sections.children.length) {
      sections.append(el('p', 'empty-state', 'No stories are available in this section. The next refresh will try again.'));
    }
  }
  function applyFilter(filter) {
    state.filter = filter;
    $('#latest-heading').textContent = filter === 'Editorial' ? 'Substantial essays & investigations' : 'Latest by section';
    leadSection.hidden = filter !== 'All';
    latestSection.hidden = filter === 'All';
    latestSection.setAttribute('aria-hidden', String(filter === 'All'));
    document.querySelectorAll('.topic').forEach(button => {
      const active = button.dataset.filter === filter;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    renderSections(state.data.stories);
  }
  document.querySelectorAll('.topic').forEach(button => button.addEventListener('click', () => applyFilter(button.dataset.filter)));

  globalThis.DailySevenSports = Object.freeze({ matchesSportsFilter });

  async function load() {
    try {
      const response = await fetch(editionUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.schemaVersion !== 2 || !Array.isArray(data.stories) || !Array.isArray(data.topStoryIds) || data.topStoryIds.length !== 7) throw new Error('Invalid edition');
      state.data = data;
      const byId = new Map(data.stories.map(story => [story.id, story]));
      const top = data.topStoryIds.map(id => byId.get(id)).filter(Boolean);
      if (top.length !== 7 || top.some(story => story.category === 'Sports' || !safeImageUrl(story.imageUrl) || !verifiedImageSize(story))) throw new Error('Incomplete Top 7');
      renderTop(top); applyFilter('All');
      $('#refresh-time').textContent = `Updated ${safeDate(data.generatedAt)}`;
      $('#dateline').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(data.generatedAt));
    } catch (error) {
      rail.replaceChildren(el('p', 'empty-state', 'Today’s live edition could not load. The checked-in Top 7 remains below.'));
      rail.setAttribute('aria-busy', 'false');
      document.querySelector('.no-script').style.display = 'block';
    }
  }
  load();
})();
