import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  scrubEvidence,
  verifyArtifactManifest,
  service,
  terminate,
  environment,
} from './verify-platform-plugin-journey.mjs';

test('journey rejects a worker artifact changed after its SHA256SUMS receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-journey-integrity-'));
  try {
    const original = Buffer.alloc(2048, 7);
    await fs.writeFile(path.join(root, 'policy.onnx'), original);
    const sha256 = createHash('sha256').update(original).digest('hex');
    await fs.writeFile(path.join(root, 'SHA256SUMS'), `${sha256}  policy.onnx\n`);
    assert.equal((await verifyArtifactManifest(root))[0].sha256, sha256);
    await fs.writeFile(path.join(root, 'policy.onnx'), Buffer.alloc(2048, 8));
    await assert.rejects(verifyArtifactManifest(root), /Artifact bytes differ/);
    await fs.writeFile(path.join(root, 'SHA256SUMS'), `${sha256}  ../policy.onnx\n`);
    await assert.rejects(verifyArtifactManifest(root), /local filenames/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('published journey evidence strips credentials and operator paths while preserving measurements', () => {
  const source = {
    reward: 1.75,
    sha256: 'a'.repeat(64),
    pythonExecutable: '/Users/example/runtime/python',
    nested: {
      token: 'private-runner-key',
      cookie: 'account-session',
      note: 'asset /Users/example/project/asset.xml service http://127.0.0.1:19001/api/v1/duck',
    },
    cases: [{ command: 'rdk_training_status', successRate: 0.2 }],
  };
  const result = scrubEvidence(source);
  assert.equal(result.reward, 1.75);
  assert.equal(result.sha256, source.sha256);
  assert.equal(result.pythonExecutable, undefined);
  assert.equal(result.nested.token, undefined);
  assert.equal(result.nested.cookie, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /\/Users\/|127\.0\.0\.1|private-runner-key|account-session/,
  );
  assert.equal(result.cases[0].command, 'rdk_training_status');
  assert.equal(source.nested.token, 'private-runner-key');
});

test('cleanup cannot hang after a service spawn fails before receiving a pid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-journey-spawn-'));
  try {
    const child = service(
      'missing-runtime',
      path.join(root, 'nonexistent-executable'),
      [],
      environment(),
      root,
    );
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(child.pid, undefined);
    assert.equal(child.closed, true);
    let timer;
    try {
      await Promise.race([
        terminate(child),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('cleanup waited for an already-emitted close event')),
            250,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const mounted of [false, true])
  test(`browser validation exits 2 when ${mounted ? 'the Studio recording overlay' : 'the simulator'} is missing`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-browser-prerequisites-'));
    let child;
    try {
      const output = path.join(root, 'evidence.json');
      const assets = path.join(root, 'assets');
      if (mounted) {
        await fs.mkdir(assets);
        await fs.writeFile(path.join(assets, 'index.html'), '<html><body></body></html>');
      }
      child = service(
        'browser-missing-assets',
        process.execPath,
        [
          fileURLToPath(new URL('./verify-platform-plugin-browser.mjs', import.meta.url)),
          '--output',
          output,
        ],
        environment({ RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT: assets }),
        root,
      );
      const code = await new Promise((resolve) => child.once('close', resolve));
      assert.equal(code, 2, child.captured);
      const report = JSON.parse(await fs.readFile(output, 'utf8'));
      assert.equal(report.status, 'blocked-missing-dependencies');
      assert.equal(report.exitCode, 2);
      assert.equal(report.cases.length, 1);
      assert.equal(report.cases[0].status, 'blocked');
      if (mounted) assert.match(report.cases[0].error, /install-microduck-overlay\.py/);
      assert.equal(
        report.outcome,
        undefined,
        'Missing real assets must not claim simulated success',
      );
      assert.deepEqual(report.cleanup, {
        browserClosed: true,
        servicesStopped: true,
        temporaryLedgerRemoved: true,
      });
    } finally {
      await terminate(child);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('journey and browser help exits zero before dependencies and writes no evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-journey-help-'));
  try {
    for (const script of ['journey', 'browser']) {
      const output = path.join(root, `${script}.json`);
      const child = service(
        `${script}-help`,
        process.execPath,
        [
          fileURLToPath(new URL(`./verify-platform-plugin-${script}.mjs`, import.meta.url)),
          '--help',
          '--output',
          output,
        ],
        environment({ RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT: path.join(root, 'missing-assets') }),
        root,
      );
      const code = await new Promise((resolve) => child.once('close', resolve));
      assert.equal(code, 0, child.captured);
      assert.match(child.captured, /Usage:/);
      assert.doesNotMatch(child.captured, /J00|B00|evidence written/);
      assert.deepEqual(await fs.readdir(root), [], 'Help must not write an evidence artifact');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('journey and browser reject unknown/missing arguments before worker or browser startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-journey-arguments-'));
  try {
    for (const script of ['journey', 'browser']) {
      for (const argumentsList of [
        ['--unknown', '--output', path.join(root, 'evidence.json')],
        ['--output'],
        ['--output', '--help'],
        ['--output', ''],
        ['extra-positional'],
      ]) {
        const child = service(
          `${script}-invalid-argument`,
          process.execPath,
          [
            fileURLToPath(new URL(`./verify-platform-plugin-${script}.mjs`, import.meta.url)),
            ...argumentsList,
          ],
          environment({ RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT: path.join(root, 'missing-assets') }),
          root,
        );
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 2, child.captured);
        assert.match(child.captured, /Invalid arguments|--output requires a file path/);
        assert.doesNotMatch(child.captured, /J00|B00|evidence written|missing-dependencies/);
        assert.deepEqual(
          await fs.readdir(root),
          [],
          'Invalid arguments must not create evidence or start the journey',
        );
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
