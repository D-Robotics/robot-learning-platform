// Browser-level UI regression sweep.
//
// Runs a real Chromium against a running instance and asserts the invariants the
// static gate in ui-layout-invariants.mjs cannot see: that the stylesheets
// actually PARSE, that the layout holds at every viewport in both themes, and
// that the accessibility tree exposes usable names and landmarks.
//
// It is deliberately separate from `npm run verify` so a machine without a
// browser still gets the static gate; this spec skips (exit 0) with a clear
// notice when Playwright is unavailable, and CI installs it explicitly.
//
//   node services/sim2real-web/ui-responsive.spec.mjs
//
// Env:
//   RDK_SIM2REAL_BASE_URL   default http://127.0.0.1:18102/
//   RDK_PLAYWRIGHT_MODULE   module id to import (default: playwright, playwright-core)
//   RDK_CHROMIUM_PATH       explicit browser binary (default: Playwright's own)
import assert from 'node:assert/strict';

const BASE = process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18102/';
const VIEWPORTS = [390, 720, 821, 900, 1024, 1080, 1100, 1280, 1440, 1680, 1920];
const THEMES = ['dark', 'light'];
const DRAWER_MAX = 1080;

async function loadPlaywright() {
  const ids = [process.env.RDK_PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const id of ids) {
    try {
      const mod = await import(id);
      return mod.chromium ? mod : (mod.default ?? null);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw?.chromium) {
  console.log(
    '[sim2real-ui-responsive] SKIP — Playwright is not installed.\n' +
      '  Install it (and a browser) to run this sweep:\n' +
      '    npm i --no-save --no-package-lock playwright && npx playwright install --with-deps chromium',
  );
  process.exit(0);
}

const launchOptions = { headless: true };
if (process.env.RDK_CHROMIUM_PATH) launchOptions.executablePath = process.env.RDK_CHROMIUM_PATH;

let browser;
try {
  browser = await pw.chromium.launch(launchOptions);
} catch (error) {
  console.log(`[sim2real-ui-responsive] SKIP — could not launch Chromium: ${error.message}`);
  process.exit(0);
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function open(viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport, height: 900 },
    colorScheme: theme,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done');
    } catch {
      /* private mode: the tour simply opens, which the sweep tolerates */
    }
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Never wait for networkidle: the workspace polls on a timer, so "idle" never
  // arrives and every page load would pay the full timeout.
  await page
    .waitForFunction(
      () =>
        (document.querySelector('[data-view-section]:not([hidden])')?.textContent || '').trim()
          .length > 40,
      { timeout: 10_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1600);
  return { context, page };
}

// ---------------------------------------------------------------- stylesheets
// A single stray character in a 230 KB stylesheet makes the browser silently drop
// every rule after it. That is invisible to a static check and to a screenshot of
// one page, and it is exactly how a "dead CSS removal" corrupted this file: the
// braces stayed balanced and the selectors stayed present, but declarations were
// mangled mid-rule and 56 of 63 @media blocks stopped parsing.
{
  const { context, page } = await open(1440, 'dark');
  const report = await page.evaluate(async () => {
    const out = [];
    for (const sheet of document.styleSheets) {
      if (!sheet.href) continue;
      const source = await (await fetch(sheet.href)).text();
      let topLevel = 0;
      let media = 0;
      try {
        for (const rule of sheet.cssRules) {
          topLevel += 1;
          if (rule.media) media += 1;
        }
      } catch (error) {
        out.push({ href: sheet.href, unreadable: String(error).slice(0, 60) });
        continue;
      }
      // declarations the browser accepted
      let parsedDeclarations = 0;
      const scan = (list) => {
        for (const rule of list) {
          if (rule.cssRules && !rule.selectorText) {
            scan(rule.cssRules);
            continue;
          }
          if (rule.style) parsedDeclarations += rule.style.length;
        }
      };
      scan(sheet.cssRules);
      // declarations present in the source (semicolons outside comments/strings)
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/['"][^'"]*['"]/g, '""');
      const sourceDeclarations = (stripped.match(/;/g) || []).length;
      out.push({
        href: sheet.href.split('/').pop(),
        sourceMedia: (source.match(/@media/g) || []).length,
        // @media blocks the source has already emptied (dropped during cleanup)
        sourceEmptyMedia: (source.match(/@media[^{]*\{\s*\}/g) || []).length,
        parsedMedia: media,
        topLevel,
        sourceBytes: source.length,
        sourceDeclarations,
        parsedDeclarations,
      });
    }
    return out;
  });
  for (const sheet of report) {
    assert.ok(!sheet.unreadable, `${sheet.href} could not be read: ${sheet.unreadable}`);
    // Media parity is the strong signal: a break in a long stylesheet makes the
    // browser drop every @media block after the error. A deleted @media that the
    // cleanup legitimately emptied is allowed, so compare against the count the
    // source would produce after dropping empty blocks.
    const expected = sheet.sourceMedia - sheet.sourceEmptyMedia;
    const floor = sheet.sourceBytes > 50_000 ? 500 : 1;
    record(
      `stylesheet parses completely: ${sheet.href}`,
      sheet.parsedMedia === expected && sheet.topLevel >= floor,
      `@media ${sheet.parsedMedia}/${expected} (source ${sheet.sourceMedia}, empty ${sheet.sourceEmptyMedia}), ${sheet.topLevel} top-level rules`,
    );
    // A declaration-level check was attempted here and removed: comparing the
    // source's declaration count against rule.style.length is invalid because the
    // browser expands shorthands (one `margin` becomes four longhands). Catching a
    // spliced declaration such as "posim: 5px" — which parses cleanly — needs a
    // real CSS linter (stylelint), not a heuristic.
  }
  await context.close();
}

// ------------------------------------------------------------------- viewports
for (const theme of THEMES) {
  for (const width of VIEWPORTS) {
    const { context, page } = await open(width, theme);
    const state = await page.evaluate(() => {
      const inScroller = (el) => {
        let cur = el.parentElement;
        while (cur) {
          const cs = getComputedStyle(cur);
          if (
            (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
            cur.scrollWidth > cur.clientWidth + 1
          )
            return true;
          cur = cur.parentElement;
        }
        return false;
      };
      const narrow = [];
      for (const el of document.querySelectorAll('#main-content *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.classList.contains('sr-only'))
          continue;
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.width < 40)) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 6))
          continue;
        if (inScroller(el)) continue;
        narrow.push(`${String(el.className).split(' ')[0]}:${Math.round(rect.width)}`);
      }
      const active = document.querySelector('[data-view-section]:not([hidden])');
      const heading = active?.querySelector('h1,h2');
      const sidebar = document.querySelector('.sidebar');
      const shell = document.querySelector('.shell-layout');
      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        narrow: narrow.slice(0, 4),
        narrowCount: narrow.length,
        titleTop: heading ? Math.round(heading.getBoundingClientRect().top) : null,
        sidebarPosition: sidebar ? getComputedStyle(sidebar).position : null,
        shellColumns: shell ? getComputedStyle(shell).gridTemplateColumns : null,
      };
    });
    record(
      `${theme} ${width}px: no page-level horizontal scroll`,
      state.docOverflow <= 1,
      `overflow ${state.docOverflow}px`,
    );
    record(
      `${theme} ${width}px: no text squeezed into a sliver`,
      state.narrowCount === 0,
      state.narrowCount ? state.narrow.join(', ') : 'none',
    );
    // "On the first screen", not "in the top half": the 2026-09 component-size
    // unification raised controls to 44px touch targets (WCAG 2.5.5), which costs
    // mobile vertical space on purpose. The percentage is printed so a further
    // slide toward the fold shows up in the log rather than passing silently.
    record(
      `${theme} ${width}px: page title is on the first screen`,
      state.titleTop !== null && state.titleTop < 900,
      `title at y=${state.titleTop} (${Math.round((state.titleTop / 900) * 100)}% of the fold)`,
    );
    const expectDrawer = width <= DRAWER_MAX;
    record(
      `${theme} ${width}px: sidebar is ${expectDrawer ? 'an off-canvas drawer' : 'an in-flow column'}`,
      expectDrawer ? state.sidebarPosition === 'fixed' : state.sidebarPosition !== 'fixed',
      `${state.sidebarPosition}, shell columns ${state.shellColumns}`,
    );
    await context.close();
  }
}

// ---------------------------------------------------------------------- a11y
{
  const { context, page } = await open(1440, 'dark');
  const client = await context.newCDPSession(page);
  await client.send('Accessibility.enable');
  const tree = async () => {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const out = [];
    const walk = (id) => {
      const n = byId.get(id);
      if (!n) return;
      if (!n.ignored) {
        const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value?.value]));
        out.push({
          role: n.role?.value || '',
          name: (n.name?.value || '').trim(),
          level: props.level,
        });
      }
      for (const child of n.childIds || []) walk(child);
    };
    for (const n of nodes) if (!n.parentId) walk(n.nodeId);
    return out;
  };
  let nodes = await tree();

  const interactive = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'slider',
    'spinbutton',
    'listbox',
  ]);
  const controls = nodes.filter((n) => interactive.has(n.role));
  const unnamed = controls.filter((n) => !n.name);
  record(
    'a11y: every interactive control has an accessible name',
    unnamed.length === 0,
    `${controls.length} controls, ${unnamed.length} unnamed`,
  );

  const h1 = nodes.filter((n) => n.role === 'heading' && n.level === 1);
  record('a11y: exactly one h1', h1.length === 1, h1.map((n) => n.name).join(' | ') || 'none');

  const landmarks = nodes.filter((n) =>
    ['navigation', 'main', 'banner', 'contentinfo'].includes(n.role),
  );
  const counts = landmarks.reduce((m, n) => m.set(n.role, (m.get(n.role) || 0) + 1), new Map());
  const unnamedRepeated = landmarks.filter((n) => !n.name && counts.get(n.role) > 1);
  record(
    'a11y: repeated landmarks are named',
    unnamedRepeated.length === 0,
    `${landmarks.length} landmarks`,
  );
  record(
    'a11y: landmark regions exist',
    landmarks.length >= 4,
    [...counts].map(([r, c]) => `${r}x${c}`).join(' '),
  );

  const glyphOnly = nodes.filter(
    (n) => n.name && /^[\u2190-\u21FF\u25A0-\u27BF\u2B00-\u2BFF\s]+$/.test(n.name),
  );
  record(
    'a11y: decorative glyphs stay out of the tree',
    glyphOnly.length === 0,
    glyphOnly
      .slice(0, 4)
      .map((n) => `"${n.name}"`)
      .join(' ') || 'clean',
  );

  await page.evaluate(() => {
    window.location.hash = '#station';
  });
  await page.waitForTimeout(900);
  nodes = await tree();
  const tabs = nodes.filter((n) => n.role === 'tab');
  record('a11y: tablists are exposed', tabs.length > 0, `${tabs.length} tabs`);

  // ---- reading order must follow visual order ----
  // A screen reader reads DOM order. CSS that reorders content (order, row-reverse,
  // absolute positioning) makes the spoken order disagree with what sighted users
  // see — invisible to every other check here, and one of the few "listen to it"
  // problems that is actually provable.
  const inversions = await page.evaluate(() => {
    const view = document.querySelector('[data-view-section]:not([hidden])');
    if (!view) return [];
    const items = [];
    for (const el of view.querySelectorAll('h1,h2,h3,h4,p,li,button,a,label,summary,td,th')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'absolute')
        continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      items.push({
        text: text.slice(0, 24),
        top: Math.round(r.top),
        left: Math.round(r.left),
        order: Number(cs.order) || 0,
      });
    }
    const bad = [];
    for (let i = 1; i < items.length; i += 1) {
      const a = items[i - 1];
      const b = items[i];
      // later in the DOM but clearly above/left of the previous readable element
      if (b.top < a.top - 24 || (Math.abs(b.top - a.top) <= 8 && b.left < a.left - 40)) {
        bad.push(`${a.text} -> ${b.text}`);
      }
    }
    const reordered = items.filter((i) => i.order !== 0).length;
    return { bad: bad.slice(0, 4), count: bad.length, reordered };
  });
  record(
    'a11y: reading order follows visual order',
    inversions.count === 0,
    inversions.count
      ? `${inversions.count} inversion(s): ${inversions.bad.join(' | ')}`
      : `no inversions (${inversions.reordered} elements use CSS order)`,
  );

  // ---- async status changes must land in a live region ----
  // A live region that is never updated, or an update outside any live region, is
  // silent for a screen-reader user even though the pixels change.
  const live = await page.evaluate(async () => {
    const regions = [...document.querySelectorAll('[aria-live]')];
    const before = regions.map((r) => r.textContent);
    const observed = [];
    const observers = regions.map(
      (r) => new MutationObserver(() => observed.push((r.id || r.className || 'live').toString())),
    );
    regions.forEach((r, i) =>
      observers[i].observe(r, { childList: true, characterData: true, subtree: true }),
    );
    // the workspace polls on a timer; give it one cycle to touch a live region
    await new Promise((resolve) => setTimeout(resolve, 6500));
    observers.forEach((o) => o.disconnect());
    const changed = regions.filter((r, i) => r.textContent !== before[i]).length;
    return { regions: regions.length, changed, observed: [...new Set(observed)].slice(0, 6) };
  });
  record(
    'a11y: live regions exist and receive updates',
    live.regions >= 5 && live.changed > 0,
    `${live.regions} live regions, ${live.changed} updated during one poll cycle (${live.observed.join(', ') || 'none'})`,
  );

  await client.detach().catch(() => {});
  await context.close();
}

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n[sim2real-ui-responsive] ${checks.length - failed.length}/${checks.length} checks passed against ${BASE}`,
);
process.exitCode = failed.length ? 1 : 0;
