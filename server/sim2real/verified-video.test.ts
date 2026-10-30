import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { verifiedVideoWebm } from './verified-video.js';
const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
describe('Verified video presentation', () => {
  it('refuses empty and oversized input before starting a transcoder', async () => {
    await expect(verifiedVideoWebm(Buffer.alloc(0))).rejects.toThrow('bounds');
    await expect(verifiedVideoWebm(Buffer.alloc(32 * 1024 * 1024 + 1))).rejects.toThrow('bounds');
  });
  it.skipIf(!available)(
    'transcodes a real MP4 to seekable VP9 WebM and reuses the verified-byte cache',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'rdk-video-test-'));
      try {
        const input = path.join(dir, 'input.mp4');
        const encode = spawnSync('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=64x64:r=5',
          '-t',
          '0.4',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          input,
        ]);
        expect(encode.status).toBe(0);
        const bytes = await readFile(input);
        const first = await verifiedVideoWebm(bytes);
        expect(first.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        expect(await verifiedVideoWebm(bytes)).toBe(first);
        const output = path.join(dir, 'output.webm');
        await writeFile(output, first);
        const probe = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_name,width,height',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            output,
          ],
          { encoding: 'utf8' },
        );
        expect(probe.status).toBe(0);
        const info = JSON.parse(probe.stdout);
        expect(info.streams[0]).toMatchObject({ codec_name: 'vp9', width: 64, height: 64 });
        expect(Number(info.format.duration)).toBeGreaterThanOrEqual(0.39);
        expect(Number(info.format.duration)).toBeLessThan(0.6);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
