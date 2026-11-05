import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceProxy } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
import {
  UI_URI,
  UI_MIME,
  uiSupported,
} from '../plugins/rdk-robot-learning-platform/scripts/mcp-app-resource.mjs';

const html = '<!doctype html><html lang="zh-CN"><body>本次实验</body></html>';
function fixture(resources = false) {
  const calls = [];
  const proxy = experienceProxy(
    {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'initialize')
          return {
            capabilities: { tools: {}, ...(resources ? { resources: { subscribe: false } } : {}) },
          };
        if (method === 'tools/list')
          return { tools: [{ name: 'existing', annotations: { readOnlyHint: true } }] };
        if (method === 'resources/list')
          return params.cursor
            ? { resources: [{ uri: 'file://existing' }] }
            : { resources: [], nextCursor: 'opaque-next' };
        return { original: true };
      },
    },
    { uiHtml: html },
  );
  return { proxy, calls };
}
const capabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } };
test('UI capability negotiation is explicit and preserves text-only hosts', async () => {
  for (const bad of [
    {},
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: UI_MIME } } } },
  ])
    assert.equal(uiSupported(bad), false);
  const f = fixture();
  await f.proxy('initialize', {});
  const catalog = await f.proxy('tools/list');
  assert.equal(catalog.tools.find((t) => t.name === 'rdk_experiment_resume')._meta, undefined);
  await assert.rejects(f.proxy('resources/read', { uri: UI_URI }), /未协商/);
});
test('negotiated Apps expose a self-contained resource and keep write tools model-only', async () => {
  const f = fixture();
  const initialized = await f.proxy('initialize', { capabilities });
  assert.deepEqual(initialized.capabilities.resources, {});
  const catalog = await f.proxy('tools/list');
  const resume = catalog.tools.find((t) => t.name === 'rdk_experiment_resume');
  assert.equal(resume._meta.ui.resourceUri, UI_URI);
  assert.deepEqual(resume._meta.ui.visibility, ['model', 'app']);
  assert.deepEqual(
    catalog.tools.find((t) => t.name === 'rdk_originman_short_train')._meta.ui.visibility,
    ['model'],
  );
  const resource = await f.proxy('resources/read', { uri: UI_URI });
  assert.equal(resource.contents[0].text, html);
  assert.equal(resource.contents[0].mimeType, UI_MIME);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, []);
  assert.equal(f.calls.filter((c) => c.method === 'tools/call').length, 0);
});
test('App resources append only on the final upstream page and preserve unrelated resource reads', async () => {
  const f = fixture(true);
  await f.proxy('initialize', { capabilities });
  assert.equal((await f.proxy('resources/list')).nextCursor, 'opaque-next');
  const last = await f.proxy('resources/list', { cursor: 'opaque-next' });
  assert.deepEqual(
    last.resources.map((r) => r.uri),
    ['file://existing', UI_URI],
  );
  assert.deepEqual(await f.proxy('resources/read', { uri: 'file://existing' }), { original: true });
});
