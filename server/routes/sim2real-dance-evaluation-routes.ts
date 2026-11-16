import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Request, Response, Router } from 'express';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { wrapAsync } from '../sim2real/http-helpers.js';

const execute = promisify(execFile);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const gate = 'originman-dance-squat-descent-ascent-v1';
const inFlight = new Map<string, Promise<void>>();
const evaluator = fileURLToPath(
  new URL('../../engines/originman-dance-ppo/evaluate_policy.py', import.meta.url),
);

type Dependencies = {
  prefix: string;
  requestOwner: (request: Request, response: Response) => string | null | undefined;
  getRun: (id: string, owner?: string) => Promise<Sim2RealRunRecord | null>;
  fetchArtifact: (run: Sim2RealRunRecord, owner?: string) => Promise<{ bytes: Buffer } | null>;
};

function sourceFor(run: Sim2RealRunRecord) {
  const scene = (
    run.metrics?.originmanDance as { sceneProvenance?: { sceneSha256?: string } } | undefined
  )?.sceneProvenance;
  const sceneSha256 = scene?.sceneSha256 ?? '';
  const policySha256 = run.artifact?.sha256 ?? '';
  if (
    run.taskId !== 'originman-dance' ||
    run.status !== 'completed' ||
    run.mock !== false ||
    run.artifact?.format?.toLowerCase() !== 'onnx' ||
    !run.training?.originmanDance ||
    !sha256.test(policySha256) ||
    !sha256.test(sceneSha256) ||
    !/^custom-policy-originman-dance-v[12]$/.test(run.contractId ?? '')
  )
    return null;
  return {
    runId: run.id,
    policySha256,
    sceneSha256,
    contractId: run.contractId,
    dance: run.training.originmanDance,
    gate,
  };
}

export function registerSim2RealDanceEvaluationRoutes(router: Router, deps: Dependencies) {
  const endpoint = deps.prefix + '/runs/:id/dance-evaluation';
  async function resolve(request: Request, response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const owner = deps.requestOwner(request, response);
    if (owner === null) return;
    const run = await deps.getRun(String(request.params.id), owner);
    if (!run) {
      response.status(404).json({ ok: false, message: '当前账号无法读取这条训练记录。' });
      return;
    }
    const source = sourceFor(run);
    if (!source) {
      response
        .status(409)
        .json({ ok: false, message: '需要已完成的真实舞蹈训练，以及可核验的策略和场景摘要。' });
      return;
    }
    const key = digest(JSON.stringify([owner ?? 'local-dev', source]));
    const root = path.join(
      process.env.RDK_SIM2REAL_STORAGE_DIR || path.resolve('.data'),
      'dance-evaluations',
    );
    return { owner, run, source, key, root, directory: path.join(root, key) };
  }

  async function readReport(directory: string, source: NonNullable<ReturnType<typeof sourceFor>>) {
    try {
      const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
      return report.source?.runId === source.runId &&
        report.source?.policySha256 === source.policySha256 &&
        report.source?.sceneSha256 === source.sceneSha256 &&
        report.source?.gate === gate
        ? report
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  router.get(
    endpoint,
    wrapAsync(async (request, response) => {
      const scope = await resolve(request, response);
      if (!scope) return;
      const evaluation = await readReport(scope.directory, scope.source);
      response
        .status(evaluation ? 200 : 404)
        .json(
          evaluation
            ? { ok: true, evaluation }
            : { ok: false, message: '这条训练记录尚无独立舞蹈评测。' },
        );
    }),
  );

  router.post(
    endpoint,
    wrapAsync(async (request, response) => {
      const scope = await resolve(request, response);
      if (!scope) return;
      const existing = await readReport(scope.directory, scope.source);
      if (existing) {
        response.json({ ok: true, reused: true, evaluation: existing });
        return;
      }
      const python = process.env.RDK_ORIGINMAN_DANCE_EVAL_PYTHON;
      const bundle = process.env.RDK_ORIGINMAN_DANCE_EVAL_BUNDLE;
      if (!python || !bundle) {
        response.status(503).json({ ok: false, message: '平台尚未配置独立舞蹈评测运行环境。' });
        return;
      }
      let work = inFlight.get(scope.key);
      if (!work) {
        if (inFlight.size >= 2) {
          response
            .status(429)
            .json({ ok: false, message: '舞蹈评测资源忙，请稍后重试同一条记录。' });
          return;
        }
        work = (async () => {
          const artifact = await deps.fetchArtifact(scope.run, scope.owner);
          if (!artifact || digest(artifact.bytes) !== scope.source.policySha256)
            throw new Error('policy-unavailable');
          await mkdir(scope.root, { recursive: true, mode: 0o700 });
          // Keep partial outputs outside the backup-managed directory.
          await mkdir(path.join(path.dirname(scope.root), 'dance-evaluation-staging'), {
            recursive: true,
            mode: 0o700,
          });
          const temporary = await mkdtemp(
            path.join(path.dirname(scope.root), 'dance-evaluation-staging', 'job-'),
          );
          try {
            await writeFile(path.join(temporary, 'policy.onnx'), artifact.bytes, { mode: 0o600 });
            await writeFile(path.join(temporary, 'input.json'), JSON.stringify(scope.source), {
              mode: 0o600,
            });
            await execute(python, [evaluator, temporary, bundle], {
              timeout: 100_000,
              maxBuffer: 64 * 1024,
            });
            const reportFile = path.join(temporary, 'report.json');
            const report = JSON.parse(await readFile(reportFile, 'utf8'));
            const video = await readFile(path.join(temporary, 'replay.mp4'));
            const trace = await readFile(path.join(temporary, 'dance-replay.npz'));
            if (
              !video.length ||
              video.length > 50 * 1024 * 1024 ||
              digest(video) !== report.replay?.videoSha256 ||
              digest(trace) !== report.replay?.sha256
            )
              throw new Error('invalid-replay');
            const published = path.join(temporary, 'published');
            await mkdir(published, { mode: 0o700 });
            await rename(
              path.join(temporary, 'replay.mp4'),
              path.join(published, report.replay.videoSha256 + '.mp4'),
            );
            await rename(
              path.join(temporary, 'dance-replay.npz'),
              path.join(published, report.replay.sha256 + '.npz'),
            );
            await writeFile(
              path.join(published, 'report.json'),
              JSON.stringify({
                ...report,
                source: scope.source,
                evaluatedAt: new Date().toISOString(),
              }),
            );
            try {
              await rename(published, scope.directory);
            } catch (error) {
              if (!(await readReport(scope.directory, scope.source))) throw error;
            }
          } finally {
            await rm(temporary, { force: true, recursive: true });
          }
        })().finally(() => inFlight.delete(scope.key));
        inFlight.set(scope.key, work);
      }
      try {
        await work;
        const evaluation = await readReport(scope.directory, scope.source);
        response.json({ ok: true, evaluation });
      } catch (error) {
        const unavailable = error instanceof Error && error.message === 'policy-unavailable';
        if (!unavailable)
          console.warn(
            '[dance-evaluation] failed',
            scope.run.id,
            (error as NodeJS.ErrnoException).code ?? 'evaluation',
          );
        response.status(unavailable ? 409 : 502).json({
          ok: false,
          message: unavailable
            ? '无法取回与原训练摘要一致的策略文件。'
            : '独立仿真评测或回放生成失败，可重试原运行记录。',
        });
      }
    }),
  );

  router.get(
    endpoint + '/replay',
    wrapAsync(async (request, response) => {
      const scope = await resolve(request, response);
      if (!scope) return;
      const report = await readReport(scope.directory, scope.source);
      const videoSha = report?.replay?.videoSha256;
      const video =
        sha256.test(videoSha ?? '') &&
        (await readFile(path.join(scope.directory, videoSha + '.mp4')).catch(() => null));
      if (!video || digest(video) !== report.replay?.videoSha256) {
        response.status(404).json({ ok: false, message: '本次独立评测暂无可核验回放。' });
        return;
      }
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('X-Replay-Video-Sha256', report.replay.videoSha256);
      const range = request.headers.range ? request.range(video.length) : undefined;
      if (range === -1) {
        response.setHeader('Content-Range', `bytes */${video.length}`);
        response.status(416).end();
        return;
      }
      if (Array.isArray(range) && range.type === 'bytes' && range.length === 1) {
        const [{ start, end }] = range;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${video.length}`);
        response.setHeader('Content-Length', end - start + 1);
        response.status(206).end(video.subarray(start, end + 1));
        return;
      }
      response.setHeader('Content-Length', video.length);
      response.end(video);
    }),
  );
}
