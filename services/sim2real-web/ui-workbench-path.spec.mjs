// Browser-level golden-path sweep for the workbench SPA.
//
// ui-layout-invariants.mjs (static) and ui-responsive.spec.mjs (layout/a11y)
// both miss the simplest user-facing regression: a view that used to mount and
// now throws. This spec walks every workbench section the way a user does —
// hash navigation, one view at a time — and asserts each one renders real
// content with no uncaught script error and no 5xx from the API behind it.
//
// Like ui-responsive.spec.mjs it is deliberately separate from `npm run
// verify`; it skips (exit 0) with a clear notice when Playwright is
// unavailable, and CI installs it explicitly in the ui-visual workflow.
//
//   node services/sim2real-web/ui-workbench-path.spec.mjs
//
// Env:
//   RDK_SIM2REAL_BASE_URL   default http://127.0.0.1:18102/
//   RDK_PLAYWRIGHT_MODULE   module id to import (default: playwright, playwright-core)
//   RDK_CHROMIUM_PATH       explicit browser binary (default: Playwright's own)
import assert from 'node:assert/strict';

const BASE = process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18102/';
// Keep in sync with the `data-view-section` values in public/index.html.
const SECTIONS = [
  'overview',
  'simulate',
  'train',
  'evaluate',
  'deploy',
  'resources',
  'records',
  'station',
];
// Views that render heavy layouts (grids, telemetry charts) get one extra beat
// before their content assertion, mirroring the settle waits used elsewhere.
const SETTLE_MS = { station: 1500 };

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
    '[sim2real-ui-path] SKIP — Playwright is not installed.\n' +
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
  console.log(`[sim2real-ui-path] SKIP — could not launch Chromium: ${error.message}`);
  process.exit(0);
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
const page = await context.newPage();

// Regression signals collected across the whole walk. A single uncaught
// exception anywhere in the 10k-line classic-script app must fail the sweep:
// it is exactly the failure class no static gate can see.
const pageErrors = [];
const consoleErrors = [];
const serverErrors = [];
const advisory5xx = new Set();
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error).slice(0, 200)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});
page.on('response', async (response) => {
  const url = response.url();
  const status = response.status();
  if (!url.includes('/api/') || status < 500) return;
  const short = `${status} ${url.replace(BASE, '/')}`;
  // Probing for the local GPU agent is expected to 502 when no agent is
  // installed; the UI renders install guidance for exactly this response.
  if (status === 502 && url.includes('/api/sim2real/local-bridge/')) {
    advisory5xx.add(`${short} (optional local GPU agent absent)`);
    return;
  }
  // Any other 503 from this service is the deliberate degradation envelope
  // (stale compute resource, storage degraded, optional surface missing) —
  // expected when the sweep runs against a machine with historical ledger
  // data, and gated by /readyz in production. A 500/502/504 during plain
  // browsing outside those envelopes is an unhandled fault and must fail.
  if (status === 503) {
    let code = '';
    try {
      code = (await response.json())?.error ?? '';
    } catch {
      /* non-JSON degradation body */
    }
    advisory5xx.add(code ? `${short} (${code})` : short);
    return;
  }
  serverErrors.push(short);
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

record(
  'workbench mounts with a visible first view',
  await page.evaluate(() =>
    Boolean(document.querySelector('[data-view-section]:not([hidden])')?.textContent.trim().length),
  ),
);

const guide = page.getByRole('dialog', { name: '使用指引' });
const topMenu = page.locator('#top-menu-button');
const guideButton = page.getByRole('menuitem', { name: '使用指引', exact: true });
async function openGuide() {
  await topMenu.click();
  await guideButton.click();
}
record('usage guide leaves the first view interactive', !(await guide.isVisible()));
await topMenu.click();
record(
  'the global menu has no recovery classroom shortcut',
  (await page.getByRole('menuitem', { name: '受扰恢复课堂', exact: true }).count()) === 0,
);
await guideButton.focus();
await page.keyboard.press('Enter');
await guide.waitFor({ state: 'visible' });
await page.keyboard.press('Escape');
await guide.waitFor({ state: 'hidden' });
record(
  'Escape returns focus to the global menu button',
  await topMenu.evaluate((button) => button === document.activeElement),
);

for (const [label, view, child, target] of [
  ['打开仿真与录制', 'simulate', 'simulate', '#simulator-title'],
  ['打开模型与契约', 'train', 'prepare', '#template-button'],
  ['打开评测与回放', 'evaluate', 'evaluation-run', '#evaluation-empty-import'],
  ['打开预检与发布', 'deploy', 'preflight', '#plan-button'],
]) {
  await openGuide();
  await guide.getByRole('link', { name: label, exact: true }).click();
  await guide.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    ([view, child]) =>
      document.body.dataset.activeView === view && document.body.dataset.flowChild === child,
    [view, child],
  );
  record(`usage guide opens ${view}/${child}`, await page.locator(target).isVisible());
}

await openGuide();
record(
  'the general guide has no OriginMan course link',
  (await guide.getByText('OriginMan 课程指引', { exact: true }).count()) === 0,
);
await guide.getByRole('button', { name: '打开图文使用手册', exact: true }).click();
const manual = page.getByRole('complementary', { name: '图文使用手册' });
const chapter = manual.getByLabel('跳到章节');
await chapter.locator('option').nth(1).waitFor({ state: 'attached' });
record(
  'illustrated manual opens alongside the workbench',
  (await manual.isVisible()) && !(await guide.isVisible()),
);
const firstImage = manual.locator('article img').first();
await firstImage.scrollIntoViewIfNeeded();
await firstImage.evaluate((img) => img.decode());
record('illustrated manual loads screenshots', (await manual.locator('article img').count()) > 0);
await chapter.selectOption({ label: 'OriginMan 舞蹈 Workshop' });
record(
  'manual chapter navigation scrolls within the manual',
  await manual.locator('#usage-manual-scroll').evaluate((scroll) => scroll.scrollTop > 0),
);
const workbenchUrl = page.url();
await Promise.all([
  page.waitForURL((url) => url.pathname.endsWith('/workshop.html')),
  manual.getByRole('link', { name: 'OriginMan 舞蹈 Workshop', exact: true }).click(),
]);
const referenceSources = page.getByRole('region', { name: '选择参考轨迹' });
await referenceSources.waitFor({ state: 'visible' });
record(
  'the OriginMan chapter opens the dance Workshop with all three reference sources',
  (await referenceSources.getByRole('link').count()) === 3,
);
await page.goto(workbenchUrl);
await openGuide();
await guide.getByRole('button', { name: '打开图文使用手册', exact: true }).click();
await manual.waitFor({ state: 'visible' });
await manual.getByRole('link', { name: '训练配置', exact: true }).click();
await page.waitForFunction(() => document.body.dataset.flowChild === 'configure');
record('manual stays open while the workbench navigates', await manual.isVisible());
await manual.getByRole('button', { name: '收起', exact: true }).click();
record(
  'closing the manual returns focus to the global menu button',
  !(await manual.isVisible()) &&
    (await topMenu.evaluate((button) => button === document.activeElement)),
);

for (const section of SECTIONS) {
  await page.evaluate((hash) => {
    window.location.hash = `#${hash}`;
  }, section);
  await page.waitForTimeout(SETTLE_MS[section] ?? 900);
  const state = await page.evaluate((id) => {
    const el = document.querySelector(`[data-view-section="${id}"]`);
    if (!el) return { present: false };
    const hidden = el.hidden || el.getClientRects().length === 0;
    const text = (el.textContent || '').trim();
    const heading = el.querySelector('h1,h2');
    return { present: true, hidden, textLength: text.length, hasHeading: Boolean(heading) };
  }, section);
  record(
    `view "${section}" is present and visible`,
    state.present && !state.hidden,
    state.present ? (state.hidden ? 'hidden' : 'visible') : 'no such data-view-section',
  );
  record(
    `view "${section}" renders real content`,
    state.present && state.textLength > 40,
    `${state.textLength ?? 0} chars${state.hasHeading ? ', heading ok' : ''}`,
  );
}

for (const key of ['robot', 'workshop']) {
  const link = new URL(BASE);
  link.searchParams.set(key, 'originman');
  link.searchParams.set('ref', 'plugin');
  link.hash = 'train/prepare';
  await page.goto(link.href, { waitUntil: 'domcontentloaded' });
  const product = page.locator('#product-select');
  record(`${key} bookmark opens OriginMan`, (await product.inputValue()) === 'originman');
  await product.selectOption('microduck');
  const updated = new URL(page.url());
  await page.reload({ waitUntil: 'domcontentloaded' });
  record(
    `manual robot choice survives a reload from the ${key} bookmark`,
    !updated.searchParams.has(key) &&
      updated.searchParams.get('ref') === 'plugin' &&
      (await product.inputValue()) === 'microduck',
  );
}

const originmanTaskPage = new URL('?robot=originman#train/prepare', BASE);
await page.goto(originmanTaskPage.href, { waitUntil: 'domcontentloaded' });
await page.locator('#originman-default-contracts').waitFor({ state: 'visible' });
const task = page.getByRole('combobox', { name: '选择训练任务契约' });
record(
  'OriginMan models start with dance and have no recovery classroom',
  (await task.inputValue()) === 'dance' &&
    (await task.locator('option[value="recovery"]').count()) === 0 &&
    (await page.locator('#originman-classroom-slot').count()) === 0,
);

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await openGuide();
await guide.getByRole('button', { name: '打开图文使用手册', exact: true }).click();
await Promise.all([
  page.waitForURL((url) => url.pathname.endsWith('/workshop.html')),
  manual.getByRole('link', { name: 'OriginMan 舞蹈 Workshop', exact: true }).click(),
]);
await referenceSources.waitFor({ state: 'visible' });
record(
  'the mobile manual opens the same Workshop without horizontal overflow',
  (await referenceSources.getByRole('link').count()) === 3 &&
    (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)),
);

record(
  'no uncaught script errors during the walk',
  pageErrors.length === 0,
  pageErrors.join(' | '),
);
record(
  'no unhandled 5xx from the API during the walk',
  serverErrors.length === 0,
  serverErrors.slice(0, 4).join(' | '),
);
// Console errors and structured 503 degradations are reported but do not fail
// the sweep by themselves: the app legitimately logs network noise for
// optional features (board agents, GPU agents) that are intentionally absent
// on a fresh install.
record(
  'console kept clean of errors (advisory)',
  true,
  consoleErrors.length
    ? `${consoleErrors.length} logged: ${consoleErrors.slice(0, 3).join(' | ')}`
    : 'silent',
);
record(
  'structured 5xx degradations (advisory)',
  true,
  advisory5xx.size ? [...advisory5xx].slice(0, 4).join(' | ') : 'none',
);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  window.location.hash = '#overview';
});
await context.close();
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n[sim2real-ui-path] ${checks.length - failed.length}/${checks.length} checks passed against ${BASE}`,
);
assert.ok(failed.length === 0, `${failed.length} golden-path check(s) failed`);
process.exitCode = 0;
