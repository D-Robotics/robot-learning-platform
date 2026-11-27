import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const base = new URL(process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18102/');
const evidence =
  process.env.RDK_ORIGINMAN_UI_EVIDENCE || join(tmpdir(), `rdk-originman-ui-${process.pid}`);
const browser = await chromium.launch({
  executablePath: process.env.RDK_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  for (const viewport of [
    { width: 1200, height: 820 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let passed = false;
    try {
      await page.goto(new URL('workshop.html', base).href);
      await page.getByRole('heading', { name: 'OriginMan 舞蹈 Workshop' }).waitFor();
      await page.getByRole('link', { name: '开始跟跳练习' }).click();
      await page.waitForURL(
        (url) =>
          url.pathname.endsWith('/originman-reference.html') &&
          url.searchParams.get('mode') === 'preset',
      );
      await page.locator('#reference-mode').waitFor();
      assert.equal(await page.locator('#reference-mode').inputValue(), 'preset');

      await page.goto(new URL('workshop.html', base).href);
      await page.getByRole('link', { name: '查看训练记录' }).click();
      await page.waitForURL((url) => url.hash === '#records/run-history');
      assert.equal(
        await page.locator('[data-record-tab="run"]').getAttribute('aria-pressed'),
        'true',
      );

      await page.goto(new URL('workshop.html', base).href);
      await page.getByRole('link', { name: '配置节拍快检' }).click();
      await page.waitForURL((url) => url.hash === '#train/configure');
      await page.locator('#originman-training-goal').waitFor();

      assert.equal(await page.locator('#originman-configure-recovery').count(), 0);
      await page.goto(new URL('workshop.html?course=recovery&start=1', base).href);
      await page.waitForURL((url) => url.searchParams.get('course') === 'dance');
      await page.getByRole('heading', { name: 'OriginMan 舞蹈 Workshop' }).waitFor();
      assert.equal(await page.getByText('受扰恢复课程').count(), 0);

      await page.goto(new URL('?robot=originman#classroom', base).href);
      await page.waitForURL((url) => url.pathname.endsWith('/workshop.html'));
      await page.getByRole('heading', { name: 'OriginMan 舞蹈 Workshop' }).waitFor();
      assert.equal(await page.evaluate(() => globalThis.innerWidth), viewport.width);
      assert.ok(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
        'horizontal overflow',
      );
      assert.deepEqual(errors, []);
      passed = true;
      console.log(
        `[originman UI] PASS ${viewport.width}px · dance entry and retired-course navigation`,
      );
    } finally {
      if (!passed) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${viewport.width}.png`) });
        await context.tracing.stop({ path: join(evidence, `${viewport.width}.zip`) });
        console.error('[originman UI] Failure trace: ' + evidence);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
