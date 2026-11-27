import { createHash, randomUUID } from 'node:crypto';
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

async function policyDirectory(owner?: string) {
  const configuredRoot = (process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  if (!configuredRoot) throw new Error('Policy archive is not configured');
  const base = path.join(await fs.realpath(configuredRoot), 'policy-artifacts');
  const scope = digest(owner === undefined ? 'local-workspace' : `account:${owner}`);
  return { base, directory: path.join(base, scope) };
}

/** Store only the exact bytes verified by the owner-scoped Run download. */
export async function retainPolicyArtifact(sha256: string, bytes: Buffer, owner?: string) {
  if (!bytes.length || bytes.length > MAX_POLICY_BYTES || digest(bytes) !== sha256) return false;
  let temporary: string | undefined;
  try {
    const { base, directory } = await policyDirectory(owner);
    for (const entry of [base, directory]) {
      await fs.mkdir(entry, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await checkDirectory(entry);
    }
    temporary = path.join(directory, `${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, path.join(directory, `${sha256}.onnx`));
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Read the existing owner-scoped archive. The caller authorizes the Run first. */
export async function readPolicyArtifact(
  sha256: string,
  owner?: string,
): Promise<PolicyArtifactRead> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { state: 'unavailable' };
  let handle: fs.FileHandle | undefined;
  try {
    const { base, directory } = await policyDirectory(owner);
    await checkDirectory(base);
    await checkDirectory(directory);
    const file = path.join(directory, `${sha256}.onnx`);
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
