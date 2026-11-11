#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This incremental patch is bound to the active production release. It refuses
// to touch a newer or different runtime; the regular full-source deploy would
// remove production overlay features that are not present in this checkout.
export const PRODUCTION_BASE = Object.freeze({
  appSha256: '441f7315d8d43dba77282eedf87ad130946087d60d1adca3235a121b91cad53d',
  htmlSha256: '89929f8d2b3a328c46d47e95271395275465bd9f19b866a6a36b69d3b1112a48',
  appFile: 'app.441f7315d8d43dba.js',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0)
    throw new Error(`Expected exactly one ${label} source block.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const oldManifestReader = `function readEditorManifest() {
  try {
    return JSON.parse($('manifest-editor').value);
  } catch (error) {
    throw new Error('JSON 格式错误：' + (error instanceof Error ? error.message : '无法解析'));
  }
}`;

const newManifestReader = `function readEditorManifest() {
  const source = String($('manifest-editor')?.value || '').trim();
  if (!source) {
    throw new Error(
      state.productId === 'originman'
        ? 'OriginMan 模板尚未载入。请先选择「舞蹈编排 · PPO」，再点击「载入当前产品模板」。'
        : 'Manifest 为空。请先载入机器人模板或导入 JSON。',
    );
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error('JSON 格式错误：' + (error instanceof Error ? error.message : '无法解析'));
  }
}`;

const oldOriginmanLoader = `  if (profile.id === 'originman') {
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
  }`;

const newOriginmanLoader = `  if (profile.id === 'originman') {
    const select = $('originman-contract-template');
    if (select && !select.value) select.value = 'dance';
    const choice = select?.value;
    if (!choice) {
      if (notify) showToast('请选择 OriginMan 训练任务后再载入对应契约。');
      return;
    }
    void originmanTemplates().then((templates) => {
      const template = templates.find((item) => item.id === choice);
      if (!template || state.productId !== 'originman' || select?.value !== choice) return;
      const editor = $('manifest-editor');
      editor.value = JSON.stringify(template.manifest, null, 2);
      originmanRunState.templateText = editor.value;
      if (notify) showToast('已载入「' + template.name + '」任务契约。');
    }).catch((error) => { if (notify) showToast(friendlyError(error, '默认契约读取失败'), 'error'); });
    return;
  }`;

export function patchOriginmanDanceDefaults(appText, htmlText) {
  let app = replaceExactlyOnce(
    appText,
    oldManifestReader,
    newManifestReader,
    'empty-manifest guard',
  );
  app = replaceExactlyOnce(
    app,
    oldOriginmanLoader,
    newOriginmanLoader,
    'OriginMan template loader',
  );

  let html = replaceExactlyOnce(
    htmlText,
    `                    <option value="" selected>请选择任务</option>\n                    <option value="dance">舞蹈编排 · PPO</option>`,
    `                    <option value="dance" selected>舞蹈编排 · PPO（默认）</option>\n                    <option value="">请选择其他任务</option>`,
    'OriginMan model contract selector',
  );
  html = replaceExactlyOnce(
    html,
    `                      <option value="">请选择目标</option>\n                      <option value="originman-dance">舞蹈编排 · PPO</option>`,
    `                      <option value="originman-dance" selected>舞蹈编排 · PPO（默认）</option>\n                      <option value="">请选择目标</option>`,
    'OriginMan training goal selector',
  );

  const oldAssetReference = './' + PRODUCTION_BASE.appFile;
  const appDigest = sha256(app);
  const appFile = `app.${appDigest.slice(0, 16)}.js`;
  html = replaceExactlyOnce(html, oldAssetReference, './' + appFile, 'hashed app asset reference');

  return { app, html, appSha256: appDigest, appFile, htmlSha256: sha256(html) };
}

function valueAfter(args, key) {
  const index = args.indexOf(key);
  return index < 0 ? '' : String(args[index + 1] || '');
}

async function main() {
  const args = process.argv.slice(2);
  const appPath = valueAfter(args, '--app');
  const htmlPath = valueAfter(args, '--html');
  const outDir = valueAfter(args, '--out-dir');
  if (!appPath || !htmlPath || !outDir)
    throw new Error(
      'Usage: patch-originman-dance-default.mjs --app FILE --html FILE --out-dir DIR',
    );

  const appText = await fs.readFile(appPath, 'utf8');
  const htmlText = await fs.readFile(htmlPath, 'utf8');
  const observed = { appSha256: sha256(appText), htmlSha256: sha256(htmlText) };
  if (
    observed.appSha256 !== PRODUCTION_BASE.appSha256 ||
    observed.htmlSha256 !== PRODUCTION_BASE.htmlSha256
  )
    throw new Error(
      'Production source hashes changed; refusing to patch. ' + JSON.stringify(observed),
    );

  const result = patchOriginmanDanceDefaults(appText, htmlText);
  await fs.mkdir(outDir, { recursive: false });
  await fs.writeFile(path.join(outDir, result.appFile), result.app, { flag: 'wx', mode: 0o644 });
  await fs.writeFile(path.join(outDir, 'index.html'), result.html, { flag: 'wx', mode: 0o644 });
  process.stdout.write(
    JSON.stringify({
      base: observed,
      output: {
        appFile: result.appFile,
        appSha256: result.appSha256,
        htmlSha256: result.htmlSha256,
      },
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
