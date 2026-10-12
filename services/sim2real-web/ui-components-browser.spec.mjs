// Real-browser regressions: inert focus, slow/failed requests and form locks.
// Run against a disposable ledger; follows ui-responsive.spec.mjs browser envs.
/* global document, showRecoverableError */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BASE = process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18102/';
const moduleId = process.env.RDK_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(moduleId);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RDK_CHROMIUM_PATH ? { executablePath: process.env.RDK_CHROMIUM_PATH } : {}),
});
const errors = [];
const screenshotDir = process.env.RDK_UI_SCREENSHOT_DIR;
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });

async function open(width, theme) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done'));
  return { context, page };
}

try {
  for (const theme of ['dark', 'light']) {
    const { context, page } = await open(390, theme);
    await page.goto(BASE);
    await page.waitForFunction(
      () => document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false',
    );
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#platform-sidebar').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('#main-content').evaluate((node) => node.inert), true);
    for (let i = 0; i < 90; i += 1) {
      await page.keyboard.press(i < 45 ? 'Tab' : 'Shift+Tab');
      assert.equal(
        await page.evaluate(() => Boolean(document.activeElement?.closest('#platform-sidebar'))),
        true,
      );
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'sidebar-toggle');
    await page.locator('#sidebar-toggle').click();
    await page.locator('#platform-sidebar [data-view-target="resources"]').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
    assert.equal(await page.locator('#main-content').evaluate((node) => node.inert), false);
    await page.evaluate(() =>
      showRecoverableError(
        '资源连接失败',
        '<img src=x onerror=alert(1)> ' + '长错误信息 '.repeat(20),
        '重新检查资源',
        () => {},
      ),
    );
    const toast = page.locator('.ui-toast').last();
    assert.equal(await toast.locator('img').count(), 0);
    await toast.locator('.ui-toast-dismiss').focus();
    await page.waitForTimeout(250);
    const layout = await toast.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      overflow: node.scrollWidth > node.clientWidth + 1,
    }));
    assert.equal(layout.overflow, false);
    assert.ok(layout.width < 390);
    assert.ok((await toast.locator('.ui-toast-dismiss').boundingBox()).height >= 36);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${theme}-mobile.png` });
    console.log(`PASS ${theme}: drawer focus trap/return/navigation and long text notification`);
    await context.close();
  }

  const { context, page } = await open(1440, 'dark');
  let releaseOverview;
  await page.route('**/api/sim2real/overview?*', async (route) => {
    await new Promise((resolve) => {
      releaseOverview = resolve;
    });
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '连接暂不可用' }),
    });
  });
  await page.goto(`${BASE}#resources`);
  await page.locator('#compute-resource-list .ui-state-loading').waitFor();
  assert.equal(await page.locator('#compute-resource-list').getByText('还没有接入 GPU').count(), 0);
  releaseOverview();
  await page.locator('#compute-resource-list .ui-state-error').waitFor();
  assert.equal(await page.locator('#compute-resource-list button').textContent(), '重新连接');
  await page.unroute('**/api/sim2real/overview?*');
  await page.locator('#compute-resource-list button').click();
  await page.locator('#compute-resource-list .ui-state-empty').waitFor();
  console.log(
    'PASS slow/failed overview remains distinct from confirmed empty data; retry recovers',
  );

  await page.locator('#compute-resource-list button').click();
  await page.locator('#compute-resource-name').fill('测试 GPU');
  await page.locator('#compute-resource-url').fill('http://127.0.0.1:19091/train');
  let submissions = 0;
  let releaseSave;
  await page.route('**/api/sim2real/compute-resources', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions += 1;
    await new Promise((resolve) => {
      releaseSave = resolve;
    });
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '服务繁忙，请重试' }),
    });
  });
  await page.locator('#compute-resource-save').click();
  await page.waitForFunction(
    () => document.querySelector('#compute-resource-form').getAttribute('aria-busy') === 'true',
  );
  await page
    .locator('#compute-resource-form')
    .evaluate((node) =>
      node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  assert.equal(await page.locator('#compute-resource-name').isDisabled(), true);
  await page.waitForTimeout(100);
  assert.equal(submissions, 1);
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/desktop-pending.png` });
  releaseSave();
  await page.waitForFunction(
    () => document.querySelector('#compute-resource-form').getAttribute('aria-busy') === 'false',
  );
  assert.equal(await page.locator('#compute-resource-name').inputValue(), '测试 GPU');
  assert.equal(await page.locator('#compute-resource-save').isEnabled(), true);
  assert.match(await page.locator('#compute-resource-form-status').textContent(), /服务繁忙/);
  console.log('PASS double submission sends one request; failure preserves input and unlocks form');
  await context.close();
  assert.deepEqual(errors, [], 'browser must not throw uncaught errors');
  console.log('[sim2real-ui-components-browser] PASS');
} finally {
  await browser.close();
}
