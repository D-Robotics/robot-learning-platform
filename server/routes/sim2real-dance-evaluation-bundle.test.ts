import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveOriginmanDanceEvaluationBundle } from './sim2real-dance-evaluation-routes.js';

it('selects the original scene for each Run and rejects mislabeled or missing scenes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'originman-evaluation-bundles-'));
  const sceneHash = (scene: string) => createHash('sha256').update(scene).digest('hex');
  const install = async (entry: string, scene: string) => {
    const directory = path.join(root, entry);
    await mkdir(path.join(directory, 'model'), { recursive: true });
    await writeFile(path.join(directory, 'model', 'scene.xml'), scene);
    return directory;
  };
  try {
    const currentSha = sceneHash('current scene');
    const legacySha = sceneHash('previous scene');
    const current = await install(currentSha, 'current scene');
    const legacy = await install('legacy-path', 'previous scene');
    expect(await resolveOriginmanDanceEvaluationBundle(currentSha, root, legacy)).toBe(current);
    expect(await resolveOriginmanDanceEvaluationBundle(legacySha, root, legacy)).toBe(legacy);
    await install(legacySha, 'content has changed');
    expect(await resolveOriginmanDanceEvaluationBundle(legacySha, root, current)).toBeNull();
    expect(await resolveOriginmanDanceEvaluationBundle('../legacy-path', root, legacy)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
