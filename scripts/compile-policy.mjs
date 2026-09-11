#!/usr/bin/env node

/**
 * Target-policy compilation adapter.
 *
 * The platform owns validation, provenance and digesting; the vendor toolchain
 * owns graph compilation. Missing tools are an explicit blocked result, never
 * a successful CPU/ONNX fallback.
 *
 * Usage:
 *   node scripts/compile-policy.mjs --input policy.onnx --output policy.bin --target x5
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = value('input');
const output = value('output');
const target = value('target') || 'x5';
const resultPath = value('result');

function fail(error, message, extra = {}) {
  const result = { ok: false, status: 'blocked', error, message, target, ...extra };
  if (resultPath) return import('node:fs/promises').then(({ writeFile }) => writeFile(resultPath, JSON.stringify(result, null, 2)));
  console.error(JSON.stringify(result));
  process.exitCode = 2;
  return Promise.resolve();
}

if (!input || !output) {
  await fail('arguments-invalid', '--input and --output are required');
} else {
  const resolvedInput = path.resolve(input);
  const resolvedOutput = path.resolve(output);
  assert(resolvedInput !== resolvedOutput, 'input and output must differ');
  let info;
  try {
    info = await stat(resolvedInput);
    await access(resolvedInput);
  } catch {
    await fail('source-artifact-missing', `source artifact not found: ${resolvedInput}`);
  }
  if (!info) {
    process.exitCode = 2;
  } else if (!info.isFile() || info.size === 0) {
    await fail('source-artifact-invalid', 'source artifact must be a non-empty file');
  } else {
  const compiler = String(process.env.RDK_BPU_COMPILER || '').trim();
  if (target !== 'x5' || !compiler || !path.isAbsolute(compiler)) {
    await fail('bpu-toolchain-unavailable', 'set an absolute RDK_BPU_COMPILER supplied by the board toolchain; source ONNX remains non-deployable', { compiler: compiler || null, source: resolvedInput });
  } else {
    const child = spawn(compiler, ['--input', resolvedInput, '--output', resolvedOutput], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(-4000); });
    child.stdout.resume();
    child.once('error', async () => { await fail('bpu-compile-failed', 'compiler could not be started', { compiler }); });
    child.once('close', async (code) => {
      if (code !== 0) return fail('bpu-compile-failed', stderr || `compiler exited with ${code}`, { compiler, exitCode: code });
      const bytes = await readFile(resolvedOutput);
      if (!bytes.length) return fail('compiled-artifact-empty', 'compiler produced an empty artifact', { compiler });
      const result = { ok: true, status: 'completed', target, compiler, format: 'bin', deployable: true, artifact: { artifactRef: `artifact://compiled/${target}/${path.basename(resolvedOutput)}`, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length } };
      if (resultPath) await (await import('node:fs/promises')).writeFile(resultPath, JSON.stringify(result, null, 2));
      else console.log(JSON.stringify(result));
    });
  }
  }
}
