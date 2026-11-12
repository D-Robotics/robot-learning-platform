import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

/** Read an operator-retained copy of media already bound to an owned Run. */
export async function readRetainedDanceVideo(
  sha256: string,
  sizeBytes: number,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const root = process.env.RDK_SIM2REAL_STORAGE_DIR?.trim();
  if (
    !root ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > 50 * 1024 * 1024
  ) {
    return null;
  }

  const file = await open(
    path.join(root, 'retained-dance-videos', `${sha256}.mp4`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== sizeBytes) return null;
    const bytes = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
      const { bytesRead } = await file.read(bytes, offset, sizeBytes - offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    return { bytes, sha256 };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
