import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAX_POLICY_BYTES = 50 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type PolicyArtifactRead =
  { state: 'retained'; bytes: Buffer } | { state: 'not-retained' | 'unavailable' };

async function checkDirectory(directory: string) {
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' && (info.mode & 0o022) !== 0) ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error('Unsafe policy artifact directory');
  }
}

/** Read the existing owner-scoped archive. The caller authorizes the Run first. */
export async function readPolicyArtifact(
  sha256: string,
  owner?: string,
): Promise<PolicyArtifactRead> {
  const configuredRoot = (process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  if (!configuredRoot || !/^[a-f0-9]{64}$/.test(sha256)) return { state: 'unavailable' };
  const root = await fs.realpath(configuredRoot).catch(() => null);
  if (!root) return { state: 'unavailable' };

  const base = path.join(root, 'policy-artifacts');
  const ownerDirectory = path.join(
    base,
    digest(owner === undefined ? 'local-workspace' : `account:${owner}`),
  );
  let handle: fs.FileHandle | undefined;
  try {
    await checkDirectory(base);
    await checkDirectory(ownerDirectory);
    const file = path.join(ownerDirectory, `${sha256}.onnx`);
    const before = await fs.lstat(file);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_POLICY_BYTES ||
      (process.getuid && before.uid !== process.getuid())
    )
      return { state: 'unavailable' };

    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
      return { state: 'unavailable' };
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return { state: 'unavailable' };
      offset += bytesRead;
    }
    const tail = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    return tail.bytesRead === 0 && digest(bytes) === sha256
      ? { state: 'retained', bytes }
      : { state: 'unavailable' };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-retained' : 'unavailable',
    };
  } finally {
    await handle?.close();
  }
}
