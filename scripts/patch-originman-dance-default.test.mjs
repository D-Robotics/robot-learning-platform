import test from 'node:test';
import assert from 'node:assert/strict';
import { patchOriginmanDanceDefaults } from './patch-originman-dance-default.mjs';

const app = `function readEditorManifest() {
  try {
    return JSON.parse($('manifest-editor').value);
  } catch (error) {
    throw new Error('JSON 格式错误：' + (error instanceof Error ? error.message : '无法解析'));
  }
}
function loadManifestTemplate({ notify = true } = {}) {
  const profile = selectedProductProfile();
  if (profile.id === 'originman') {
    if (!notify) return;
    const choice = $('originman-contract-template')?.value;
    if (!choice) {
      showToast('请先选择训练任务，再载入对应契约。');
      return;
    }
    void originmanTemplates().then((templates) => {
      const template = templates.find((item) => item.id === choice);
      if (!template || state.productId !== 'originman' || $('originman-contract-template')?.value !== choice) return;
      const editor = $('manifest-editor');
      editor.value = JSON.stringify(template.manifest, null, 2);
      originmanRunState.templateText = editor.value;
      if (notify) showToast('已载入「' + template.name + '」任务契约。');
    }).catch((error) => { if (notify) showToast(friendlyError(error, '默认契约读取失败'), 'error'); });
    return;
  }
}`;

const html = `<select id="originman-contract-template">
                    <option value="" selected>请选择任务</option>
                    <option value="dance">舞蹈编排 · PPO</option>
                    <option value="recovery">受扰恢复 · SAC</option>
                  </select>
                    <select id="originman-training-goal">
                      <option value="">请选择目标</option>
                      <option value="originman-dance">舞蹈编排 · PPO</option>
                    </select>
<script src="./app.441f7315d8d43dba.js"></script>`;

test('OriginMan defaults to dance, loads silently, and reports an empty manifest clearly', () => {
  const result = patchOriginmanDanceDefaults(app, html);
  assert.match(result.app, /if \(select && !select\.value\) select\.value = 'dance';/);
  assert.doesNotMatch(result.app, /if \(!notify\) return;/);
  assert.match(result.app, /OriginMan 模板尚未载入/);
  assert.match(result.html, /<option value="dance" selected>舞蹈编排 · PPO（默认）<\/option>/);
  assert.match(
    result.html,
    /<option value="originman-dance" selected>舞蹈编排 · PPO（默认）<\/option>/,
  );
  assert.ok(result.html.includes(`<script src="./${result.appFile}"></script>`));
  assert.equal(result.appSha256.slice(0, 16), result.appFile.slice('app.'.length, -'.js'.length));
});

test('patching fails closed if an expected source block is missing or duplicated', () => {
  assert.throws(
    () => patchOriginmanDanceDefaults(app.replace('manifest-editor', 'manifest-box'), html),
    /empty-manifest guard/,
  );
  assert.throws(() => patchOriginmanDanceDefaults(app + app, html), /empty-manifest guard/);
  assert.throws(
    () => patchOriginmanDanceDefaults(app, html.replace('value="dance">', 'value="jive">')),
    /OriginMan model contract selector/,
  );
});
