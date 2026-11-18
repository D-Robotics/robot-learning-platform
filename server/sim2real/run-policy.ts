import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { fetchLocalRunArtifact } from './local-runner.js';
import { getSim2RealComputeResourceSecret } from './sim2real-store.js';

export async function resolveRunPolicyDownload(
  run: Sim2RealRunRecord,
  owner: string | undefined,
  accountId: string,
  timeoutMs?: number,
) {
  if (run.backend !== 'local' || !run.externalRunId)
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_ARTIFACT_BACKEND_UNSUPPORTED',
      message: '仅本地 worker 运行提供制品下载。',
    } as const;
  if (run.status !== 'completed' || run.mock)
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_RUN_NOT_COMPLETED',
      message: '只有已完成的真实运行才能下载制品。',
    } as const;
  const artifact = run.artifact;
  if (artifact?.format?.toLowerCase() !== 'onnx' || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? ''))
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_ARTIFACT_NOT_DOWNLOADABLE',
      message: '该运行没有可下载的 ONNX 制品记录。',
    } as const;
  const resource = run.computeResourceId
    ? await getSim2RealComputeResourceSecret(run.computeResourceId, owner)
    : null;
  const fetched =
    accountId && (!run.computeResourceId || resource)
      ? await fetchLocalRunArtifact({
          accountId,
          externalRunId: run.externalRunId,
          timeoutMs,
          ...(resource
            ? { runnerUrl: resource.resource.runnerUrl, runnerToken: resource.runnerToken ?? '' }
            : {}),
        })
      : null;
  if (!fetched)
    return {
      ok: false,
      status: 502,
      code: 'SIM2REAL_ARTIFACT_FETCH_FAILED',
      message: '无法从执行端取回制品字节。',
    } as const;
  if (fetched.sha256 !== artifact.sha256)
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_ARTIFACT_DIGEST_MISMATCH',
      message: '制品摘要与台账记录不一致，已拒绝下发。',
    } as const;
  return { ok: true, ...fetched } as const;
}
