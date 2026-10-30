/** Trusted instructor material, kept separate from account-owned training Runs. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function readOriginmanReference() {
  const directory = process.env.ORIGINMAN_REFERENCE_DIR?.trim();
  if (!directory)
    return { available: false as const, reason: 'instructor-reference-not-configured' };
  try {
    const manifestFile = path.join(directory, 'reference.json');
    if ((await stat(manifestFile)).size > 16384) throw new Error('manifest-size');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const validCount = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 31;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.source !== 'instructor-reference' ||
      manifest.simulationOnly !== true ||
      typeof manifest.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(manifest.id) ||
      typeof manifest.title !== 'string' ||
      !manifest.title ||
      manifest.title.length > 160 ||
      typeof manifest.note !== 'string' ||
      manifest.note.length > 1600 ||
      !validCount(manifest.comparison?.baselineRecovered) ||
      !validCount(manifest.comparison?.rlRecovered) ||
      manifest.comparison?.cases !== 31 ||
      !Number.isSafeInteger(manifest.comparison?.seed) ||
      !/^[a-f0-9]{64}$/.test(manifest.video?.sha256) ||
      !Number.isSafeInteger(manifest.video?.bytes) ||
      manifest.video.bytes < 1 ||
      manifest.video.bytes > 32 * 1024 * 1024
    )
      throw new Error('manifest-contract');
    const videoFile = path.join(directory, 'comparison.mp4');
    if ((await stat(videoFile)).size !== manifest.video.bytes) throw new Error('video-size');
    const bytes = await readFile(videoFile);
    if (
      bytes.length !== manifest.video.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== manifest.video.sha256
    )
      throw new Error('video-digest');
    return {
      available: true as const,
      bytes,
      metadata: {
        id: manifest.id as string,
        title: manifest.title as string,
        note: manifest.note as string,
        source: 'instructor-reference',
        simulationOnly: true,
        isUserTraining: false,
        comparison: {
          cases: 31,
          baselineRecovered: manifest.comparison.baselineRecovered as number,
          rlRecovered: manifest.comparison.rlRecovered as number,
          seed: manifest.comparison.seed as number,
        },
        video: { sha256: manifest.video.sha256 as string, bytes: manifest.video.bytes as number },
        videoPath: '/sim2real/workshops/originman/reference-video',
      },
    };
  } catch {
    return { available: false as const, reason: 'instructor-reference-unverified' };
  }
}
