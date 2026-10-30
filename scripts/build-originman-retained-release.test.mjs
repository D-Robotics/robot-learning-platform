import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

test('retained builder rejects a different upstream before creating an output release', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'originman-retained-build-'));
  try {
    const spec = JSON.parse(
      await fs.readFile(
        'services/sim2real-web/retained-release/originman-retained-runtime.json',
        'utf8',
      ),
    );
    const first = Object.keys(spec.files)[0];
    const base = path.join(scratch, 'base'),
      output = path.join(scratch, 'release');
    await fs.mkdir(path.dirname(path.join(base, first)), { recursive: true });
    await fs.writeFile(path.join(base, first), 'different production version');
    const result = spawnSync(
      process.execPath,
      ['scripts/build-originman-retained-release.mjs', '--base', base, '--output', output],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Upstream mismatch/);
    await assert.rejects(fs.access(output));
    assert.equal(await fs.readFile(path.join(base, first), 'utf8'), 'different production version');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
