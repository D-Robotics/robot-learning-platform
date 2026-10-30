import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readOriginmanReference } from './originman-reference.js';
const before = process.env.ORIGINMAN_REFERENCE_DIR;
const folders: string[] = [];
afterEach(async () => {
  if (before === undefined) delete process.env.ORIGINMAN_REFERENCE_DIR;
  else process.env.ORIGINMAN_REFERENCE_DIR = before;
  await Promise.all(
    folders.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
it('does not advertise an unconfigured instructor reference', async () => {
  delete process.env.ORIGINMAN_REFERENCE_DIR;
  expect((await readOriginmanReference()).available).toBe(false);
});
it('keeps a digest-bound instructor reference separate from user training and refuses changed bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'originman-reference-'));
  folders.push(directory);
  process.env.ORIGINMAN_REFERENCE_DIR = directory;
  const bytes = Buffer.from('protocol fixture only; not a physics video');
  await fs.writeFile(path.join(directory, 'comparison.mp4'), bytes);
  await fs.writeFile(
    path.join(directory, 'reference.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'reference-fixture',
      title: 'Protocol fixture',
      note: 'Not RL quality evidence',
      source: 'instructor-reference',
      simulationOnly: true,
      comparison: { cases: 31, baselineRecovered: 17, rlRecovered: 26, seed: 7 },
      video: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    }),
  );
  const result = await readOriginmanReference();
  expect(result.available).toBe(true);
  if (!result.available) throw new Error('reference missing');
  expect(result.metadata.isUserTraining).toBe(false);
  expect(JSON.stringify(result.metadata)).not.toContain(directory);
  await fs.writeFile(path.join(directory, 'comparison.mp4'), Buffer.alloc(bytes.length));
  expect(await readOriginmanReference()).toEqual({
    available: false,
    reason: 'instructor-reference-unverified',
  });
});
