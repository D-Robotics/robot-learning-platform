import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const cache = new Map<string, Promise<Buffer>>();
let inFlight = 0;
const MAX_INPUT = 32 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** Presentation transcode only. Call after ownership and source SHA validation. */
export async function verifiedVideoWebm(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_INPUT) throw new Error('video_input_out_of_bounds');
  const key = createHash('sha256').update(bytes).digest('hex');
  const existing = cache.get(key);
  if (existing) return existing;
  if (inFlight >= 2) throw new Error('video_transcoder_busy');
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  inFlight++;
  const task = (async () => {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), 'rdk-verified-video-'));
      const input = path.join(directory, 'input.mp4');
      await writeFile(input, bytes, { mode: 0o600 });
      const output = path.join(directory, 'output.webm');
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          process.env.RDK_VIDEO_FFMPEG || 'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            'mp4',
            '-i',
            input,
            '-map',
            '0:v:0',
            '-an',
            '-c:v',
            'libvpx-vp9',
            '-deadline',
            'realtime',
            '-cpu-used',
            '8',
            '-threads',
            '2',
            '-b:v',
            '1400k',
            '-pix_fmt',
            'yuv420p',
            '-fs',
            String(MAX_OUTPUT),
            '-f',
            'webm',
            output,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'], shell: false },
        );
        let failure: Error | undefined;
        const timer = setTimeout(() => {
          failure = new Error('video_transcode_timeout');
          child.kill('SIGKILL');
        }, 30000);
        child.stderr.resume();
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('video_transcoder_unavailable'));
        });
        child.once('close', async (code) => {
          clearTimeout(timer);
          if (failure || code !== 0) {
            reject(failure ?? new Error('video_transcode_failed'));
            return;
          }
          try {
            const info = await stat(output);
            if (!info.size || info.size >= MAX_OUTPUT)
              throw new Error('video_output_out_of_bounds');
            const result = await readFile(output);
            if (!result.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
              throw new Error('video_transcode_failed');
            resolve(result);
          } catch {
            reject(new Error('video_transcode_failed'));
          }
        });
      });
    } finally {
      inFlight--;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  })();
  cache.set(key, task);
  try {
    return await task;
  } catch (error) {
    if (cache.get(key) === task) cache.delete(key);
    throw error;
  }
}
