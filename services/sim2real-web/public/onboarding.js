/* global BASE_PATH */
(() => {
  const guide = document.getElementById('usage-guide');
  if (!guide) return;

  const open = () => {
    if (!guide.open) guide.showModal();
  };

  const helpButton = document.getElementById('onboarding-help-button');
  const topMenuButton = document.getElementById('top-menu-button');
  helpButton?.addEventListener('click', () => {
    topMenuButton?.focus({ preventScroll: true });
    open();
  });

  const manual = document.getElementById('usage-manual');
  const manualTitle = document.getElementById('usage-manual-title');
  const manualScroll = document.getElementById('usage-manual-scroll');
  const manualContent = document.getElementById('usage-manual-content');
  const chapter = document.getElementById('usage-manual-chapter');
  const status = document.getElementById('usage-manual-status');
  const retry = document.getElementById('usage-manual-retry');
  const narrow = window.matchMedia('(max-width: 1280px)');
  let manualLoaded = false;
  let manualLoading = false;
  let headings = [];

  async function loadManual() {
    if (manualLoaded || manualLoading) return;
    manualLoading = true;
    retry.hidden = true;
    status.hidden = false;
    status.textContent = '正在加载使用手册…';
    try {
      const response = await fetch(BASE_PATH + '/help/user-guide.json');
      if (!response.ok) throw new Error('Usage manual unavailable');
      const { html } = await response.json();
      if (typeof html !== 'string' || !html.trim()) throw new Error('Usage manual missing');
      // escape-audit:allow The same-origin route renders only repository Markdown with raw HTML disabled and MarkdownIt URL validation.
      manualContent.innerHTML = html;
      headings = [...manualContent.querySelectorAll('h2')];
      headings.forEach((heading, index) => {
        chapter.add(new Option(heading.textContent, String(index)));
      });
      chapter.disabled = headings.length === 0;
      manualLoaded = true;
      status.hidden = true;
    } catch {
      status.textContent = '暂时无法加载图文手册。';
      retry.hidden = false;
    } finally {
      manualLoading = false;
    }
  }

  function hideManual({ restoreFocus = true } = {}) {
    manual.hidden = true;
    if (restoreFocus) topMenuButton?.focus({ preventScroll: true });
  }

  document.getElementById('usage-manual-open').addEventListener('click', () => {
    guide.close();
    manual.hidden = false;
    manualTitle.focus({ preventScroll: true });
    void loadManual();
  });
  document.getElementById('usage-manual-close').addEventListener('click', () => hideManual());
  retry.addEventListener('click', () => void loadManual());
  chapter.addEventListener('change', () => {
    if (!chapter.value) return;
    const heading = headings[Number(chapter.value)];
    manualScroll.scrollTop += heading.getBoundingClientRect().top - manualScroll.getBoundingClientRect().top;
    chapter.value = '';
  });
  manual.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideManual();
  });
  manual.querySelector('.usage-manual-actions').addEventListener('click', (event) => {
    if (event.target.closest('a[href]') && narrow.matches &&
        event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      hideManual({ restoreFocus: false });
      document.getElementById('main-content')?.focus({ preventScroll: true });
    }
  });

  guide.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    guide.close();
    // Links use the same hash navigation and history as the workbench.
    // An identical hash does not dispatch hashchange, so move focus here.
    if (link.hash === window.location.hash) {
      document.getElementById('main-content')?.focus({ preventScroll: true });
    }
  });

  if (new URLSearchParams(window.location.search).get('tour') === '1' &&
      document.getElementById('auth-gate')?.hidden !== false) {
    open();
  }
})();
