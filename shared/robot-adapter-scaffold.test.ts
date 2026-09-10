import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { validateRobotAdapterManifest } from './robot-adapter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('robot adapter scaffold', () => {
  it('creates two schema-conformant, explicitly mock manifests and refuses overwrite', () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'rdk-adapter-scaffold-'));
    roots.push(workdir);
    mkdirSync(path.join(workdir, 'adapters'));
    mkdirSync(path.join(workdir, 'profiles'));
    const script = path.resolve('scripts/create-robot-adapter.mjs');
    const args = [script, 'test-rover', 'diff-drive', 'Test Rover'];
    const created = spawnSync(process.execPath, args, { cwd: workdir, encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const adapter = JSON.parse(
      readFileSync(path.join(workdir, 'adapters', 'test-rover.json'), 'utf8'),
    );
    const profile = JSON.parse(
      readFileSync(path.join(workdir, 'profiles', 'test-rover-profile.json'), 'utf8'),
    );
    expect(validateRobotAdapterManifest(adapter)).toMatchObject({ valid: true, errors: [] });
    expect(validateRobotAdapterManifest(profile)).toMatchObject({ valid: true, errors: [] });
    expect(adapter).toMatchObject({
      hardwareProfileId: 'test-rover-profile',
      provenance: { kind: 'template', mock: true },
      runtime: { actionProjection: 'identity' },
      policy: { actionSize: 2 },
    });

    const overwrite = spawnSync(process.execPath, args, { cwd: workdir, encoding: 'utf8' });
    expect(overwrite.status).not.toBe(0);
    expect(overwrite.stderr).toContain('refusing to overwrite');
  });
});
