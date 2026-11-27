import type { Sim2RealComputeResource, Sim2RealRunRecord } from '../../shared/sim2real.js';
import { fetchLocalRunArtifact } from './local-runner.js';
import { readPolicyArtifact, retainPolicyArtifact } from './policy-artifact-store.js';
import { getSim2RealComputeResourceSecret, readSim2RealRelayArtifact } from './sim2real-store.js';

export type RunPolicyRetention =
  | { state: 'not-applicable' }
  | { state: 'not-retained' | 'unavailable'; sha256: string }
  | { state: 'retained'; sha256: string; bytes: number };

function validateRunPolicy(run: Sim2RealRunRecord) {
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
  const sha256 = run.artifact?.sha256 ?? '';
  if (run.artifact?.format?.toLowerCase() !== 'onnx' || !/^[a-f0-9]{64}$/.test(sha256))
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_ARTIFACT_NOT_DOWNLOADABLE',
      message: '该运行没有可下载的 ONNX 制品记录。',
    } as const;
  return { ok: true, sha256, externalRunId: run.externalRunId } as const;
}

async function readRunPolicyArchive(
  run: Sim2RealRunRecord,
  owner: string | undefined,
  sha256: string,
): Promise<{ retention: RunPolicyRetention; bytes?: Buffer }> {
  if (run.relayAgentUrl) {
    const bytes = await readSim2RealRelayArtifact(sha256);
    return bytes
      ? { retention: { state: 'retained', sha256, bytes: bytes.length }, bytes }
      : { retention: { state: 'unavailable', sha256 } };
  }
  const stored = await readPolicyArtifact(sha256, owner);
  return stored.state === 'retained'
    ? { retention: { state: 'retained', sha256, bytes: stored.bytes.length }, bytes: stored.bytes }
    : { retention: { state: stored.state, sha256 } };
}

export async function getRunPolicyRetention(
  run: Sim2RealRunRecord,
  owner: string | undefined,
): Promise<RunPolicyRetention> {
  const policy = validateRunPolicy(run);
  return policy.ok
    ? (await readRunPolicyArchive(run, owner, policy.sha256)).retention
    : { state: 'not-applicable' };
}

/** The caller must resolve the Run under the authenticated owner before reading bytes. */
export async function resolveRunPolicyDownload(
  run: Sim2RealRunRecord,
  owner: string | undefined,
  accountId: string,
  options: {
    timeoutMs?: number;
    allowWorker?: (resource: Sim2RealComputeResource) => boolean;
    retain?: boolean;
  } = {},
) {
  const policy = validateRunPolicy(run);
  if (!policy.ok) return { ...policy, retention: { state: 'not-applicable' } } as const;

  const { retention, bytes } = await readRunPolicyArchive(run, owner, policy.sha256);
  if (bytes)
    return {
      ok: true,
      bytes,
      sha256: policy.sha256,
      source: 'platform-retained',
      retention,
    } as const;
  const resource =
    !run.relayAgentUrl && run.computeResourceId
      ? await getSim2RealComputeResourceSecret(run.computeResourceId, owner)
      : null;
  const fetched =
    !run.relayAgentUrl &&
    accountId &&
    (!run.computeResourceId ||
      (resource && (!options.allowWorker || options.allowWorker(resource.resource))))
      ? await fetchLocalRunArtifact({
          accountId,
          externalRunId: policy.externalRunId,
          timeoutMs: options.timeoutMs,
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
      message: run.relayAgentUrl ? '中继制品尚未上传或无法读取。' : '无法从执行端取回制品字节。',
      retention,
    } as const;
  if (fetched.sha256 !== policy.sha256)
    return {
      ok: false,
      status: 409,
      code: 'SIM2REAL_ARTIFACT_DIGEST_MISMATCH',
      message: '制品摘要与台账记录不一致，已拒绝下发。',
      retention,
    } as const;
  const retained =
    options.retain && (await retainPolicyArtifact(fetched.sha256, fetched.bytes, owner));
  const archiveReceipt: RunPolicyRetention = retained
    ? { state: 'retained', sha256: fetched.sha256, bytes: fetched.bytes.length }
    : retention;
  return {
    ok: true,
    ...fetched,
    source: 'worker',
    retention: archiveReceipt,
  } as const;
}
