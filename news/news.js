'use strict';

(function newsModule(root) {
  const DEFAULT_SNAPSHOT = 'https://herby9000.github.io/herbyprojects/news/data/news.json';

  function createNewsApp(options) {
    const document = options.document;
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const snapshotUrl = options.snapshotUrl || DEFAULT_SNAPSHOT;
    let stories = [];
    let topIds = [];
    let requestVersion = 0;

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

    function storyButton(story, position) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'story-card';
      button.dataset.category = story.category || '';
      button.setAttribute('aria-label', `Read ${story.title || 'story'}`);

      const number = document.createElement('span');
      number.className = 'story-number';
      number.textContent = position ? String(position).padStart(2, '0') : story.category || 'Story';
      const title = document.createElement('strong');
      title.textContent = story.title || 'Untitled story';
      const details = document.createElement('span');
      details.className = 'story-details';
      details.textContent = [story.source, story.category].filter(Boolean).join(' · ');
      button.append(number, title, details);
      button.addEventListener('click', () => openStory(story));
      return button;
    }

    function renderToday() {
      leadSection.hidden = false;
      topStories.replaceChildren();
      const byId = new Map(stories.map(story => [story.id, story]));
      topIds.slice(0, 7).forEach((id, index) => {
        const story = byId.get(id);
        if (story) topStories.append(storyButton(story, index + 1));
      });

      sectionStories.replaceChildren();
      for (const category of ['Politics', 'Tech', 'Sports']) {
        const categoryStories = stories.filter(story => story.category === category);
        if (!categoryStories.length) continue;
        const section = document.createElement('section');
        section.className = 'story-section';
        const heading = document.createElement('h2');
        heading.textContent = category;
        const grid = document.createElement('div');
        grid.className = 'story-grid';
        categoryStories.forEach(story => grid.append(storyButton(story)));
        section.append(heading, grid);
        sectionStories.append(section);
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
      sectionStories.replaceChildren();
      const heading = document.createElement('h1');
      heading.className = 'selected-heading';
      heading.textContent = section;
      const grid = document.createElement('div');
      grid.className = 'story-grid';
      stories.filter(story => story.category === section).forEach(story => grid.append(storyButton(story)));
      sectionStories.append(heading, grid);
    }

    function setSummary(story) {
      readerBody.replaceChildren();
      const label = document.createElement('p');
      label.className = 'summary-label';
      label.textContent = 'Feed summary';
      const summary = document.createElement('p');
      summary.textContent = story.summary || 'This feed supplied a headline but no article summary.';
      readerBody.append(label, summary);
    }

    function setFullArticle(article) {
      readerBody.replaceChildren();
      for (const text of article.paragraphs || []) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        readerBody.append(paragraph);
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
        setFullArticle(result.article);
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
        stories = Array.isArray(snapshot.stories) ? snapshot.stories : [];
        topIds = Array.isArray(snapshot.topStoryIds) ? snapshot.topStoryIds : [];
        renderToday();
        const date = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
        snapshotStatus.textContent = date ? `Briefing updated ${date}` : 'Today’s briefing';
      } catch {
        snapshotStatus.textContent = 'Today’s briefing could not be loaded. Please try again shortly.';
      }
    }

    return { start, selectSection, openStory };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createNewsApp };
  if (root.document?.documentElement?.hasAttribute('data-news-auto')) {
    createNewsApp({ document: root.document }).start();
  }
}(typeof window !== 'undefined' ? window : globalThis));
