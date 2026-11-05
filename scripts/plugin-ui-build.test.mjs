import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { embedUiAssets } from './build-plugin-ui.mjs';
test('embedding preserves JavaScript replacement tokens and cannot turn a script string into markup', () => {
  const source = 'const currency = "$& $` $\'"; const close = "</script>";';
  const html = embedUiAssets(
    '<!doctype html><html><head><link rel="stylesheet" href="./tokens.css"><script type="module" src="./experiment-page.mjs"></script></head><body></body></html>',
    ':root{color:inherit}',
    source,
  );
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelectorAll('script').length, 1);
  assert.equal(
    dom.window.document.querySelector('script').textContent,
    source.replace('</script>', '<\\/script>'),
  );
  assert.equal(dom.window.document.querySelectorAll('script[src], link[href]').length, 0);
  dom.window.close();
});
