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
  const bbcSection = $('#bbc-top-stories');
  const bbcHeadlines = $('#bbc-headlines');
  const reader = $('#reader');
  let readerRequestVersion = 0;
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
  function safeBbcUrl(value) {
    try {
      const url = new URL(value);
      const bbcHosts = new Set(['bbc.com', 'www.bbc.com', 'bbc.co.uk', 'www.bbc.co.uk']);
      return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && bbcHosts.has(url.hostname)
        ? url.href
        : '';
    } catch (_) { return ''; }
  }
  function verifiedImageSize(story) {
    const width = Number(story.imageWidth); const height = Number(story.imageHeight);
    return Number.isInteger(width) && Number.isInteger(height) && width >= 960 && height >= 540 ? [width, height] : null;
  }
  function snapshotImage(story) {
    const url = safeImageUrl(story?.imageUrl || story?.image);
    const size = verifiedImageSize(story || {});
    return url && size ? { url, width: size[0], height: size[1], alt: typeof story.imageAlt === 'string' ? story.imageAlt.trim() : '' } : null;
  }
  function extractedImage(candidate) {
    const url = safeImageUrl(candidate?.url);
    const width = Number(candidate?.width); const height = Number(candidate?.height);
    const hasSize = Number.isInteger(width) && width >= 960 && Number.isInteger(height) && height >= 540;
    if (!url || (candidate?.width !== undefined && !hasSize) || (candidate?.height !== undefined && !hasSize)) return null;
    return {
      url,
      width: hasSize ? width : 1200,
      height: hasSize ? height : 675,
      verifyNaturalSize: !hasSize,
      alt: typeof candidate.alt === 'string' ? candidate.alt.trim() : '',
      caption: typeof candidate.caption === 'string' ? candidate.caption.trim() : '',
    };
  }
  function storyImageFrame(story, className = '') {
    const data = snapshotImage(story);
    if (!data) return null;
    const frame = el('figure', `story-image-frame${className ? ` ${className}` : ''}`);
    const image = el('img', 'story-image');
    image.src = data.url; image.alt = data.alt; image.width = data.width; image.height = data.height;
    image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    const unavailable = el('div', 'image-status', 'Publisher image unavailable');
    unavailable.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true; unavailable.hidden = false; frame.classList.add('image-unavailable');
    });
    frame.append(image, unavailable);
    return frame;
  }
  function readerFigure(data, className, fallback = null) {
    const figure = el('figure', `reader-image ${className}`);
    const image = el('img', 'reader-image-media');
    image.src = data.url; image.alt = data.alt; image.width = data.width; image.height = data.height;
    image.loading = className === 'reader-lead-image' ? 'eager' : 'lazy';
    image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    const unavailable = el('div', 'reader-image-status', 'Publisher image unavailable');
    unavailable.hidden = true;
    image.addEventListener('error', () => {
      if (fallback && fallback.url !== data.url) {
        figure.replaceWith(readerFigure(fallback, className));
        return;
      }
      image.hidden = true; unavailable.hidden = false; figure.classList.add('image-unavailable');
    });
    if (data.verifyNaturalSize) {
      image.addEventListener('load', () => {
        if (image.naturalWidth >= 960 && image.naturalHeight >= 540) return;
        if (fallback && fallback.url !== data.url) figure.replaceWith(readerFigure(fallback, className));
        else figure.remove();
      }, { once: true });
    }
    figure.append(image, unavailable);
    if (data.caption) figure.append(el('figcaption', 'reader-image-caption', data.caption));
    return figure;
  }
  function renderReaderCopy(story, body, article = null) {
    const copy = $('#reader-copy');
    const nodes = [];
    const extractedLead = extractedImage(article?.leadImage);
    const snapshotLead = snapshotImage(story);
    const lead = extractedLead || snapshotLead;
    if (lead) nodes.push(readerFigure(lead, 'reader-lead-image', extractedLead ? snapshotLead : null));
    const blocks = Array.isArray(article?.blocks) && article.blocks.some(block => block?.type === 'paragraph') ? article.blocks : null;
    if (blocks) {
      blocks.forEach(block => {
        if (block?.type === 'paragraph' && typeof block.text === 'string' && block.text.trim()) {
          nodes.push(el('p', '', block.text.trim()));
        } else if (block?.type === 'image') {
          const image = extractedImage(block);
          if (image && image.url !== lead?.url) nodes.push(readerFigure(image, 'reader-inline-image'));
        }
      });
    } else {
      String(body || '').split(/\n{2,}/).filter(Boolean).forEach(paragraph => nodes.push(el('p', '', paragraph)));
    }
    copy.replaceChildren(...nodes);
  }
  async function loadArticle(story, version) {
    try {
      const response = await fetch('/api/news/article', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: story.url }),
      });
      const result = await response.json();
      if (version !== readerRequestVersion || !reader.open) return;
      if (!response.ok || !result.ok || !Array.isArray(result.article?.paragraphs)) {
        $('#reader-disclosure').textContent = result.error || 'Full article unavailable; showing the feed summary.';
        return;
      }
      const article = result.article;
      $('#reader-title').textContent = article.title || story.title;
      $('#reader-byline').textContent = [article.siteName || story.source, article.byline].filter(Boolean).join(' · ');
      renderReaderCopy(story, article.paragraphs.join('\n\n'), article);
      $('#reader-disclosure').textContent = 'Full article extracted for private reading. This reader never embeds a publisher page.';
    } catch (_) {
      if (version === readerRequestVersion && reader.open) {
        $('#reader-disclosure').textContent = 'Full article unavailable; showing the feed summary.';
      }
    }
  }
  function openReader(story, options = {}) {
    const version = ++readerRequestVersion;
    $('#reader-kicker').textContent = `${story.category} · ${story.region}`;
    $('#reader-title').textContent = story.title;
    $('#reader-byline').textContent = meta(story);
    const body = story.body || story.summary;
    renderReaderCopy(story, body);
    const storyLabels = Array.isArray(story.labels) ? story.labels : [story.category, story.region];
    const labels = $('#reader-labels'); labels.replaceChildren(...storyLabels.map(label => el('span', '', label)));
    $('#reader-disclosure').textContent = options.loadArticle
      ? 'Loading available article text. Showing the BBC feed summary while it loads.'
      : `${story.contentStatus}. This reader never fabricates missing article text or embeds a publisher page.`;
    const source = $('#reader-source');
    const sourceUrl = safeSourceUrl(story.url);
    source.hidden = !sourceUrl;
    if (sourceUrl) source.href = sourceUrl;
    source.setAttribute('aria-label', `Optional: continue reading ${story.title} at ${story.source} (opens new tab)`);
    if (typeof reader.showModal === 'function') reader.showModal(); else reader.setAttribute('open', '');
    document.body.classList.add('reader-open');
    if (options.loadArticle) void loadArticle(story, version);
  }
  reader.addEventListener('close', () => {
    readerRequestVersion += 1;
    document.body.classList.remove('reader-open');
  });
  reader.addEventListener('click', event => { if (event.target === reader) reader.close(); });

  function makeStoryCardInteractive(card, story, protectDrag = false) {
    let pointerStart = null;
    let dragged = false;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Read ${story.title} in app`);
    if (protectDrag) {
      card.addEventListener('pointerdown', event => {
        pointerStart = { x: event.clientX, y: event.clientY };
        dragged = false;
      });
      card.addEventListener('pointermove', event => {
        if (!pointerStart) return;
        if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 10) dragged = true;
      });
      card.addEventListener('pointerup', () => { pointerStart = null; });
      card.addEventListener('pointercancel', () => { pointerStart = null; dragged = false; });
    }
    card.addEventListener('click', () => {
      if (dragged) { dragged = false; return; }
      openReader(story);
    });
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      dragged = false;
      openReader(story);
    });
  }
  function renderTop(stories) {
    rail.replaceChildren();
    stories.forEach((story, index) => {
      const card = el('article', `story-card ${index === 0 ? 'story-card-lead' : 'story-card-secondary'}`);
      const frame = storyImageFrame(story);
      if (index === 0) frame.querySelector('img').loading = 'eager';
      card.append(frame, el('p', 'card-number', String(index + 1).padStart(2, '0')),
        el('p', 'story-meta', meta(story)), el('h3', '', story.title), el('p', 'dek', story.summary),
        el('span', 'read-cue', 'Read in app'));
      makeStoryCardInteractive(card, story, true);
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
        const frame = storyImageFrame(story, 'list-story-image');
        if (frame) {
          item.classList.add('has-story-image');
          item.append(frame);
        }
        item.append(el('p', 'story-meta', meta(story)), el('h3', '', story.title),
          el('p', 'list-dek', story.summary), el('p', 'labels', (story.labels || []).join(' · ')));
        makeStoryCardInteractive(item, story);
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
  function renderBbcTopStories(stories) {
    bbcHeadlines.replaceChildren();
    if (Array.isArray(stories)) {
      stories.forEach(story => {
        const title = typeof story?.title === 'string' ? story.title.trim() : '';
        const url = safeBbcUrl(story?.url);
        if (!title || !url) return;
        const item = el('li', 'bbc-headline');
        const button = el('button', 'bbc-headline-button', title);
        button.type = 'button';
        button.setAttribute('aria-label', `Read ${title} in app`);
        const readerStory = {
          title,
          url,
          summary: typeof story.description === 'string' && story.description.trim()
            ? story.description.trim()
            : 'This BBC feed supplied a headline but no article summary.',
          source: 'BBC',
          publisher: 'BBC',
          category: 'BBC Top Stories',
          region: 'Today',
          labels: ['BBC Top Stories'],
          contentStatus: 'BBC feed summary',
          imageUrl: story.imageUrl || story.image,
          imageWidth: story.imageWidth,
          imageHeight: story.imageHeight,
          imageAlt: story.imageAlt,
        };
        button.addEventListener('click', () => openReader(readerStory, { loadArticle: true }));
        const media = storyImageFrame(readerStory, 'bbc-headline-media');
        if (media) item.append(media);
        item.append(button, el('span', 'bbc-attribution', 'BBC'));
        bbcHeadlines.append(item);
      });
    }
    const hidden = state.filter !== 'All' || !bbcHeadlines.children.length;
    bbcSection.hidden = hidden;
    bbcSection.setAttribute('aria-hidden', String(hidden));
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
    renderBbcTopStories(state.data.bbcTopStories);
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
