'use strict';

(function newsModule(root) {
  const DEFAULT_SNAPSHOT = 'https://herby9000.github.io/herbyprojects/news/data/news.json';
  const SPORTS_FILTERS = ['All', 'Rugby', 'Saracens', 'Blue Jays', 'Leafs'];

  function hasExactLabel(story, label) {
    return Array.isArray(story?.labels) && story.labels.includes(label);
  }

  function matchesSportsFilter(story, filter) {
    const isSaracens = story?.focus === 'Saracens' || hasExactLabel(story, 'Saracens') || story?.source === 'Saracens';
    if (filter === 'All') return true;
    if (filter === 'Saracens') return isSaracens;
    if (filter === 'Blue Jays') return story?.focus === 'Blue Jays' || hasExactLabel(story, 'Blue Jays') || story?.source === 'Toronto Blue Jays';
    if (filter === 'Leafs') return story?.focus === 'Maple Leafs' || hasExactLabel(story, 'Maple Leafs') || story?.source === 'Sportsnet Maple Leafs';
    if (filter === 'Rugby') {
      return !isSaracens && (hasExactLabel(story, 'Rugby') || hasExactLabel(story, 'England Rugby') || story?.source === 'BBC Rugby Union');
    }
    return false;
  }

  function createNewsApp(options) {
    const document = options.document;
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const snapshotUrl = options.snapshotUrl || DEFAULT_SNAPSHOT;
    let stories = [];
    let topIds = [];
    let requestVersion = 0;
    let selectedSportsFilter = 'All';

    const leadSection = document.querySelector('#leadSection');
    const topStories = document.querySelector('#topStories');
    const sectionStories = document.querySelector('#sectionStories');
    const snapshotStatus = document.querySelector('#snapshotStatus');
    const dialog = document.querySelector('#readerDialog');
    const readerTitle = document.querySelector('#readerTitle');
    const readerSource = document.querySelector('#readerSource');
    const readerByline = document.querySelector('#readerByline');
    const readerStatus = document.querySelector('#readerStatus');
    const readerBody = document.querySelector('#readerBody');
    const readerLink = document.querySelector('#readerLink');
    const closeButton = document.querySelector('#readerClose');

    function safeSourceUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : '';
      } catch {
        return '';
      }
    }

    function safeImageUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : '';
      } catch {
        return '';
      }
    }

    function validateEdition(snapshot) {
      const editionStories = Array.isArray(snapshot?.stories) ? snapshot.stories : [];
      const editionTopIds = Array.isArray(snapshot?.topStoryIds) ? snapshot.topStoryIds : [];
      if (editionTopIds.length !== 7 || new Set(editionTopIds).size !== 7) throw new Error('invalid_edition');

      const byId = new Map(editionStories.map(story => [story.id, story]));
      for (const id of editionTopIds) {
        const story = byId.get(id);
        if (!story || story.category === 'Sports' || !safeImageUrl(story.imageUrl)) throw new Error('invalid_edition');
      }
      return { stories: editionStories, topIds: editionTopIds };
    }

    function storyButton(story, position) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'story-card';
      button.dataset.category = story.category || '';
      button.setAttribute('aria-label', `Read ${story.title || 'story'}`);

      if (position) {
        const media = document.createElement('span');
        media.className = 'story-media';
        const image = document.createElement('img');
        image.className = 'story-image';
        image.src = safeImageUrl(story.imageUrl);
        image.alt = '';
        image.setAttribute('decoding', 'async');
        image.setAttribute('referrerpolicy', 'no-referrer');
        const unavailable = document.createElement('span');
        unavailable.className = 'image-unavailable-label';
        unavailable.textContent = 'Image unavailable';
        unavailable.setAttribute('aria-hidden', 'true');
        image.addEventListener('error', () => button.classList.add('image-unavailable'), { once: true });
        media.append(image, unavailable);
        button.append(media);
      }

      const number = document.createElement('span');
      number.className = 'story-number';
      number.textContent = position ? String(position).padStart(2, '0') : story.category || 'Story';
      const title = document.createElement('strong');
      title.textContent = story.title || 'Untitled story';
      const details = document.createElement('span');
      details.className = 'story-details';
      details.textContent = [story.source, story.category].filter(Boolean).join(' · ');
      const copy = document.createElement('span');
      copy.className = 'story-copy';
      copy.append(number, title, details);
      button.append(copy);
      button.addEventListener('click', () => openStory(story));
      return button;
    }

    function renderToday() {
      leadSection.hidden = false;
      topStories.replaceChildren();
      const byId = new Map(stories.map(story => [story.id, story]));
      topIds.forEach((id, index) => {
        const story = byId.get(id);
        if (story) topStories.append(storyButton(story, index + 1));
      });
      sectionStories.replaceChildren();
    }

    function renderSports() {
      const sports = stories.filter(story => story.category === 'Sports');
      const heading = document.createElement('h1');
      heading.className = 'selected-heading';
      heading.textContent = 'Sports';

      const filters = document.createElement('nav');
      filters.className = 'sports-filters';
      filters.setAttribute('aria-label', 'Sports filters');
      for (const filter of SPORTS_FILTERS) {
        const count = filter === 'All' ? sports.length : sports.filter(story => matchesSportsFilter(story, filter)).length;
        const button = document.createElement('button');
        const selected = filter === selectedSportsFilter;
        button.type = 'button';
        button.className = 'sports-filter';
        button.dataset.sportsFilter = filter;
        button.setAttribute('aria-pressed', String(selected));
        button.setAttribute('aria-label', `${filter}, ${count} ${count === 1 ? 'story' : 'stories'}`);
        button.classList.toggle('active', selected);
        const label = document.createElement('span');
        label.textContent = filter;
        const countLabel = document.createElement('span');
        countLabel.className = 'sports-filter-count';
        countLabel.textContent = String(count);
        countLabel.setAttribute('aria-hidden', 'true');
        button.append(label, countLabel);
        button.addEventListener('click', () => {
          selectedSportsFilter = filter;
          renderSports();
        });
        filters.append(button);
      }

      const matches = selectedSportsFilter === 'All'
        ? sports.slice(0, 12)
        : sports.filter(story => matchesSportsFilter(story, selectedSportsFilter));
      const grid = document.createElement('div');
      grid.className = 'story-grid';
      matches.forEach(story => grid.append(storyButton(story)));
      sectionStories.replaceChildren(heading, filters, grid);
      if (!matches.length) {
        const empty = document.createElement('p');
        empty.className = 'sports-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = `No ${selectedSportsFilter} stories in this edition.`;
        grid.replaceWith(empty);
      }
    }

    function selectSection(section) {
      document.querySelectorAll('[data-section]').forEach(button => {
        const selected = button.dataset.section === section;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      if (section === 'Today') return renderToday();

      leadSection.hidden = true;
      if (section === 'Sports') return renderSports();
      sectionStories.replaceChildren();
      const heading = document.createElement('h1');
      heading.className = 'selected-heading';
      heading.textContent = section;
      const grid = document.createElement('div');
      grid.className = 'story-grid';
      stories.filter(story => story.category === section).forEach(story => grid.append(storyButton(story)));
      sectionStories.append(heading, grid);
    }

    function articleFigure(url, alt, caption, title, className) {
      const safeUrl = safeImageUrl(url);
      if (!safeUrl) return null;
      const figure = document.createElement('figure');
      figure.className = className;
      const image = document.createElement('img');
      image.src = safeUrl;
      image.alt = typeof alt === 'string' ? alt : '';
      if (typeof title === 'string') image.title = title;
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      image.setAttribute('referrerpolicy', 'no-referrer');
      image.addEventListener('load', () => {
        if (image.naturalWidth < 960 || image.naturalHeight < 540) figure.remove();
      }, { once: true });
      image.addEventListener('error', () => figure.remove(), { once: true });
      figure.append(image);
      if (typeof caption === 'string' && caption.trim()) {
        const figcaption = document.createElement('figcaption');
        figcaption.textContent = caption;
        figure.append(figcaption);
      }
      return figure;
    }

    function appendHero(story, leadImage) {
      const leadUrl = safeImageUrl(leadImage?.url);
      const heroUrl = leadUrl || safeImageUrl(story.imageUrl);
      const hero = articleFigure(heroUrl, leadUrl ? leadImage.alt : (story.title || ''), '', '', 'reader-hero');
      if (hero) readerBody.append(hero);
      return heroUrl;
    }

    function setSummary(story) {
      readerBody.replaceChildren();
      appendHero(story);
      const label = document.createElement('p');
      label.className = 'summary-label';
      label.textContent = 'Feed summary';
      const summary = document.createElement('p');
      summary.textContent = story.summary || 'This feed supplied a headline but no article summary.';
      readerBody.append(label, summary);
    }

    function setFullArticle(article, story) {
      readerBody.replaceChildren();
      const heroUrl = appendHero(story, article.leadImage);
      const blocks = Array.isArray(article.blocks)
        ? article.blocks
        : (article.paragraphs || []).map(text => ({ type: 'paragraph', text }));
      for (const block of blocks) {
        if (block?.type === 'paragraph' && typeof block.text === 'string') {
          const paragraph = document.createElement('p');
          paragraph.textContent = block.text;
          readerBody.append(paragraph);
        } else if (block?.type === 'image') {
          const blockUrl = safeImageUrl(block.url);
          if (!blockUrl || blockUrl === heroUrl) continue;
          const figure = articleFigure(blockUrl, block.alt, block.caption, block.title, 'reader-article-image');
          if (figure) readerBody.append(figure);
        }
      }
    }

    async function openStory(story) {
      const version = ++requestVersion;
      readerTitle.textContent = story.title || 'Untitled story';
      readerSource.textContent = story.source || '';
      readerByline.textContent = '';
      readerStatus.textContent = 'Loading full article…';
      setSummary(story);
      const sourceUrl = safeSourceUrl(story.url);
      readerLink.hidden = !sourceUrl;
      if (sourceUrl) readerLink.href = sourceUrl;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      closeButton.focus();

      try {
        const response = await fetchImpl('/api/news/article', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: story.url })
        });
        const result = await response.json();
        if (version !== requestVersion || !dialog.open) return;
        if (!response.ok || !result.ok || !Array.isArray(result.article?.paragraphs)) {
          readerStatus.textContent = result.error || 'Full article unavailable; showing the feed summary.';
          return;
        }
        readerTitle.textContent = result.article.title || story.title || 'Untitled story';
        readerSource.textContent = result.article.siteName || story.source || '';
        readerByline.textContent = result.article.byline || '';
        setFullArticle(result.article, story);
        readerStatus.textContent = 'Full article extracted for private reading.';
      } catch {
        if (version === requestVersion && dialog.open) readerStatus.textContent = 'Full article unavailable; showing the feed summary.';
      }
    }

    function closeDialog() {
      requestVersion += 1;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }

    async function start() {
      document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => selectSection(button.dataset.section)));
      closeButton.addEventListener('click', closeDialog);
      dialog.addEventListener('cancel', () => { requestVersion += 1; });
      try {
        const response = await fetchImpl(snapshotUrl, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('snapshot unavailable');
        const snapshot = await response.json();
        const edition = validateEdition(snapshot);
        stories = edition.stories;
        topIds = edition.topIds;
        renderToday();
        const date = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
        snapshotStatus.textContent = date ? `Briefing updated ${date}` : 'Today’s briefing';
      } catch (error) {
        leadSection.hidden = false;
        topStories.replaceChildren();
        sectionStories.replaceChildren();
        snapshotStatus.textContent = error.message === 'invalid_edition'
          ? 'Edition error: today’s Top 7 is incomplete or unsafe, so it has not been displayed.'
          : 'Today’s briefing could not be loaded. Please try again shortly.';
      }
    }

    return { start, selectSection, openStory };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createNewsApp, matchesSportsFilter };
  if (root.document?.documentElement?.hasAttribute('data-news-auto')) {
    createNewsApp({ document: root.document }).start();
  }
}(typeof window !== 'undefined' ? window : globalThis));
