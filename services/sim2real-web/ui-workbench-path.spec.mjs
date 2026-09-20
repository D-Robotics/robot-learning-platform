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

record(
  'workbench mounts with a visible first view',
  await page.evaluate(() =>
    Boolean(document.querySelector('[data-view-section]:not([hidden])')?.textContent.trim().length),
  ),
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
