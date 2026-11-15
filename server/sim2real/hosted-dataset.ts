import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const HOSTED_DATASET_LIMIT = 50 * 1024 * 1024;
export const HOSTED_DATASET_SCHEME = 'dataset-hosted://';
const digestPattern = /^[a-f0-9]{64}$/;

export class HostedDatasetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function hostedDatasetReference(sha256: string, filename: string): string {
  return HOSTED_DATASET_SCHEME + sha256 + '/' + encodeURIComponent(filename);
}

export function parseHostedDatasetReference(uri: string | undefined) {
  if (!uri?.startsWith(HOSTED_DATASET_SCHEME)) return null;
  const [sha256, name, ...extra] = uri.slice(HOSTED_DATASET_SCHEME.length).split('/');
  if (!digestPattern.test(sha256) || !name || extra.length) return null;
  try {
    const filename = decodeURIComponent(name);
    if (!validDatasetFilename(filename)) return null;
    return { sha256, filename };
  } catch {
    return null;
  }
}

export function validDatasetFilename(filename: unknown): filename is string {
  return (
    typeof filename === 'string' &&
    filename.length > 0 &&
    filename.length <= 180 &&
    filename !== '.' &&
    filename !== '..' &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    ![...filename].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function ownerDirectory(owner: string | undefined): string {
  const storage = String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  if (!storage)
    throw new HostedDatasetError(
      503,
      'SIM2REAL_DATASET_STORAGE_UNAVAILABLE',
      '数据集存储尚未配置。',
    );
  const scope = createHash('sha256')
    .update(owner === undefined ? '' : 'account:' + owner)
    .digest('hex');
  return path.resolve(storage, 'hosted-datasets', scope);
}

export async function stageHostedDataset(source: Readable, owner: string | undefined) {
  const directory = ownerDirectory(owner);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = path.join(directory, randomUUID() + '.tmp');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      sizeBytes += chunk.length;
      if (sizeBytes > HOSTED_DATASET_LIMIT) {
        done(
          new HostedDatasetError(413, 'SIM2REAL_DATASET_TOO_LARGE', '数据文件不能超过 50 MiB。'),
        );
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const discard = async () => {
    await unlink(staging).catch(() => {});
  };
  try {
    // Keep the HTTP request outside pipeline so a size failure can return JSON.
    const onError = (error: Error) => measure.destroy(error);
    source.once('error', onError);
    const write = pipeline(
      measure,
      createWriteStream(staging, { flags: 'wx', mode: 0o600, flush: true }),
    );
    try {
      source.pipe(measure);
      await write;
    } finally {
      source.unpipe(measure);
      source.off('error', onError);
      if (!source.destroyed && !source.readableEnded) source.resume();
    }
    if (!sizeBytes)
      throw new HostedDatasetError(400, 'SIM2REAL_DATASET_EMPTY', '请选择非空的数据文件。');
    const sha256 = hash.digest('hex');
    return {
      sha256,
      sizeBytes,
      async publish() {
        try {
          await link(staging, path.join(directory, sha256 + '.bin'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await openHostedDataset(owner, sha256, sizeBytes);
          await existing.close();
        }
      },
      discard,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function openHostedDataset(
  owner: string | undefined,
  sha256: string,
  sizeBytes: number,
) {
  if (
    !digestPattern.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > HOSTED_DATASET_LIMIT
  ) {
    throw new HostedDatasetError(409, 'SIM2REAL_DATASET_FILE_INVALID', '数据集文件记录无效。');
  }
  const file = await open(
    path.join(ownerDirectory(owner), sha256 + '.bin'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    throw new HostedDatasetError(404, 'SIM2REAL_DATASET_FILE_MISSING', '托管文件暂不可用。');
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== sizeBytes)
      throw new HostedDatasetError(
        409,
        'SIM2REAL_DATASET_FILE_INVALID',
        '托管文件大小与记录不一致。',
      );
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false }))
      hash.update(chunk);
    if (hash.digest('hex') !== sha256)
      throw new HostedDatasetError(
        409,
        'SIM2REAL_DATASET_FILE_INVALID',
        '托管文件的 SHA-256 与记录不一致。',
      );
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
