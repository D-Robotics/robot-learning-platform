#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This patch is bound to the deployed composite release. It changes only the
// progress track height and its cache key; it refuses to touch a different
// release or any source block that is missing or duplicated.
export const PRODUCTION_BASE = Object.freeze({
  htmlSha256: '7af8043ed2b1192c826f0a3d3c2954d66ab3b27408ff23fc154c4640d5df041a',
  cssSha256: '9750a1e08f25891dc5c330c48aa4d74636c5e3470d0d48116c5028b454ba9860',
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

const oldCssReference = 'href="./app.css?v=duck-lab-99"';
const newCssReference = 'href="./app.css?v=duck-lab-100"';
const oldProgressRule = `body #train-module-run-model .run-progress-track {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--line-strong) 62%, transparent);
}`;
const newProgressRule = `body #train-module-run-model .run-progress-track {
  height: 22px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--line-strong) 62%, transparent);
}`;

export function patchRunProgressTrack(htmlText, cssText) {
  const html = replaceExactlyOnce(htmlText, oldCssReference, newCssReference, 'app.css cache key');
  const css = replaceExactlyOnce(cssText, oldProgressRule, newProgressRule, '8px progress track');
  return { html, css, htmlSha256: sha256(html), cssSha256: sha256(css) };
}

function valueAfter(args, key) {
  const index = args.indexOf(key);
  return index < 0 ? '' : String(args[index + 1] || '');
}

async function main() {
  const args = process.argv.slice(2);
  const htmlPath = valueAfter(args, '--html');
  const cssPath = valueAfter(args, '--css');
  const outDir = valueAfter(args, '--out-dir');
  if (!htmlPath || !cssPath || !outDir)
    throw new Error('Usage: patch-run-progress-track.mjs --html FILE --css FILE --out-dir DIR');

  const htmlText = await fs.readFile(htmlPath, 'utf8');
  const cssText = await fs.readFile(cssPath, 'utf8');
  const observed = { htmlSha256: sha256(htmlText), cssSha256: sha256(cssText) };
  if (
    observed.htmlSha256 !== PRODUCTION_BASE.htmlSha256 ||
    observed.cssSha256 !== PRODUCTION_BASE.cssSha256
  )
    throw new Error(
      'Production source hashes changed; refusing to patch. ' + JSON.stringify(observed),
    );

  const result = patchRunProgressTrack(htmlText, cssText);
  await fs.mkdir(outDir, { recursive: false });
  await fs.writeFile(path.join(outDir, 'index.html'), result.html, { flag: 'wx', mode: 0o644 });
  await fs.writeFile(path.join(outDir, 'app.css'), result.css, { flag: 'wx', mode: 0o644 });
  process.stdout.write(
    JSON.stringify({
      base: observed,
      output: { htmlSha256: result.htmlSha256, cssSha256: result.cssSha256 },
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
