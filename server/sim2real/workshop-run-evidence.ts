import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { isOriginmanWorkshopEngine } from '../../shared/originman-workshop.js';
import { requestLocalTrainingStatus } from './local-runner.js';
import { isSim2RealRunnerNotFound } from './robogo-runner.js';
import {
  getSim2RealRun,
  getSim2RealComputeResourceSecret,
  updateSim2RealRun,
} from './sim2real-store.js';

/** Recover a missing receipt from the original worker without launching another job. */
export async function readWorkshopRunEvidence(
  run: Sim2RealRunRecord,
  owner?: string,
): Promise<{
  run: Sim2RealRunRecord;
  workshopEvidenceIssue?:
    | 'binding-missing'
    | 'worker-unavailable'
    | 'job-missing'
    | 'receipt-missing'
    | 'receipt-mismatch';
}> {
  const config = run.training?.originmanWorkshop;
  if (
    !config ||
    run.metrics?.originmanWorkshop ||
    run.status !== 'completed' ||
    run.taskId !== 'originman-recovery' ||
    !isOriginmanWorkshopEngine(run.training?.engine) ||
    run.mock !== false ||
    run.backend !== 'local'
  )
    return { run };
  if (run.relayAgentUrl || !run.externalRunId || !run.computeResourceId || !run.artifact?.sha256)
    return { run, workshopEvidenceIssue: 'binding-missing' };
  const selected = await getSim2RealComputeResourceSecret(run.computeResourceId, owner);
  if (!selected || selected.resource.source === 'local-agent')
    return { run, workshopEvidenceIssue: 'binding-missing' };
  let latest;
  try {
    latest = await requestLocalTrainingStatus({
      accountId: owner ?? 'local-dev',
      externalRunId: run.externalRunId,
      runnerUrl: selected.resource.runnerUrl,
      runnerToken: selected.runnerToken ?? '',
      timeoutMs: 5000,
    });
  } catch (error) {
    return {
      run,
      workshopEvidenceIssue: isSim2RealRunnerNotFound(error) ? 'job-missing' : 'worker-unavailable',
    };
  }
  const metrics = latest.metrics;
  const evidence = metrics?.originmanWorkshop;
  if (
    latest.status !== 'completed' ||
    latest.mock !== false ||
    latest.externalRunId !== run.externalRunId ||
    !metrics ||
    metrics.engine !== run.training?.engine ||
    latest.artifact?.sha256 !== run.artifact.sha256 ||
    (evidence !== undefined &&
      (evidence.policySha256 !== run.artifact.sha256 ||
        evidence.phase !== config.phase ||
        evidence.requestedTimesteps !== config.timesteps ||
        evidence.seed !== config.seed ||
        evidence.pushMaxForce !== config.pushMaxForce ||
        evidence.sourceRunId !== config.sourceRunId ||
        (evidence.groupId !== undefined && evidence.groupId !== config.groupId)))
  )
    return { run, workshopEvidenceIssue: 'receipt-mismatch' };
  if (!evidence) return { run, workshopEvidenceIssue: 'receipt-missing' };
  const updated = await updateSim2RealRun(
    run.id,
    { metrics: { ...metrics, ...run.metrics, originmanWorkshop: evidence } },
    owner,
  );
  return updated ? { run: updated } : { run, workshopEvidenceIssue: 'receipt-missing' };
}

export async function getWorkshopRun(id: string, owner?: string) {
  const run = await getSim2RealRun(id, owner);
  return run ? (await readWorkshopRunEvidence(run, owner)).run : null;
}
