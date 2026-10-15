import { createHash } from 'node:crypto';
import type {
  Sim2RealDemonstrations,
  Sim2RealModelManifest,
  Sim2RealRunRecord,
  Sim2RealTelemetryRecord,
  Sim2RealTrainingData,
} from '../../shared/sim2real.js';
import {
  getSim2RealModel,
  getSim2RealRun,
  listSim2RealTelemetry,
  SIM2REAL_TELEMETRY_RECORD_CAP,
  telemetryRevision,
} from './sim2real-store.js';

export const TRAINING_DEMONSTRATION_MAX_BYTES = 4 * 1024 * 1024;
export const TRAINING_DEMONSTRATION_MIN_ROWS = 12;

export class TrainingDemonstrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

/** Construct one deterministic vector-only dataset from the accepted owner-scoped snapshot. */
export function buildTrainingDemonstrations(input: {
  run: Sim2RealRunRecord;
  sourceContract: Sim2RealModelManifest['contract'];
  targetContract: Sim2RealModelManifest['contract'];
  telemetry: readonly Sim2RealTelemetryRecord[];
}): { demonstrations: Sim2RealDemonstrations; trainingData: Sim2RealTrainingData } {
  const { run, sourceContract, targetContract, telemetry } = input;
  const reject = (code: string, message: string): never => {
    throw new TrainingDemonstrationError(code, message);
  };
  if (run.mock === true || run.metrics?.syntheticData === true) {
    reject(
      'SIM2REAL_DEMONSTRATION_SYNTHETIC',
      '演示来源 Run 使用 mock 或合成数据，不能用作真实示教训练。',
    );
  }
  // This transport carries only observation/action vectors. A vision slot or
  // carried state must not be silently discarded while training a different
  // feed-forward graph with an apparently compatible vector width.
  for (const contract of [sourceContract, targetContract]) {
    if (
      contract.observationLayout.some((item) => 'modality' in item && item.modality === 'image') ||
      contract.inputs?.image !== undefined ||
      contract.inputs?.stateInputs !== undefined ||
      contract.inputs?.stateOutputs !== undefined ||
      contract.state !== undefined
    ) {
      reject(
        'SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED',
        '当前示教训练通道只支持纯向量、无循环状态的 offline-bc；图像或循环策略请使用对应引擎/训练 CLI。',
      );
    }
  }
  if (
    targetContract.inputs?.observation !== undefined &&
    targetContract.inputs.observation !== 'observation'
  ) {
    reject(
      'SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED',
      'offline-bc 当前固定导出 observation 向量输入名；目标契约的 inputs.observation 必须省略或声明为 observation。',
    );
  }
  if (
    sourceContract.id !== targetContract.id ||
    sourceContract.observationSize !== targetContract.observationSize ||
    sourceContract.actionSize !== targetContract.actionSize ||
    (run.contractId !== undefined && run.contractId !== targetContract.id)
  ) {
    reject(
      'SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH',
      '演示来源与训练模型的契约或向量维度不一致。',
    );
  }
  let source: Sim2RealDemonstrations['source'] | undefined;
  let rows = 0;
  let bytes = 0;
  const lines: string[] = [];
  for (const chunk of telemetry) {
    if (
      chunk.runId !== run.id ||
      chunk.modelId !== run.modelId ||
      chunk.contractId !== targetContract.id
    ) {
      reject('SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH', '遥测块的 Run、模型或契约不匹配。');
    }
    if (chunk.source === 'demo-fixture') {
      reject('SIM2REAL_DEMONSTRATION_SYNTHETIC', '示例夹具不能用作真实示教训练。');
    }
    if (!['browser', 'import', 'board-agent'].includes(chunk.source)) {
      reject('SIM2REAL_DEMONSTRATION_SOURCE_INVALID', '演示来源类型无效。');
    }
    if (source && source !== chunk.source) {
      reject('SIM2REAL_DEMONSTRATION_SOURCE_INVALID', '请选择只包含一种来源的录制 Run。');
    }
    source = chunk.source as Sim2RealDemonstrations['source'];
    for (const sample of chunk.samples) {
      if (sample.event?.mock === true) {
        reject('SIM2REAL_DEMONSTRATION_SYNTHETIC', '演示包含 mock 板端会话。');
      }
      // Session markers are not training frames and carry no vectors by design.
      if (sample.event) continue;
      if (chunk.source === 'browser' && sample.pairing !== 'policy-inference-v1') {
        reject(
          'SIM2REAL_DEMONSTRATION_PAIRING_UNVERIFIED',
          '浏览器轨迹缺少同次推理配对标记，请使用新版录制器重新采集；旧录制可能把动作标签泄漏到输入。',
        );
      }
      const { observation, action } = sample;
      if (
        !Array.isArray(observation) ||
        !Array.isArray(action) ||
        observation.length !== targetContract.observationSize ||
        action.length !== targetContract.actionSize ||
        !observation.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
        !action.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        reject(
          'SIM2REAL_DEMONSTRATION_VECTOR_INVALID',
          '每个演示帧必须包含契约维度一致的有限 observation/action 向量。',
        );
      }
      const line = `${JSON.stringify({ observation, action })}\n`;
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > TRAINING_DEMONSTRATION_MAX_BYTES) {
        reject(
          'SIM2REAL_DEMONSTRATION_TOO_LARGE',
          '演示训练数据超过 4 MiB，请先分段录制或选择更短的 Run。',
        );
      }
      lines.push(line);
      rows += 1;
    }
  }
  if (!source || rows < TRAINING_DEMONSTRATION_MIN_ROWS) {
    reject('SIM2REAL_DEMONSTRATION_TOO_SHORT', '演示至少需要 12 帧完整 observation/action 向量。');
  }
  const jsonl = lines.join('');
  const trainingData: Sim2RealTrainingData = {
    sourceRunId: run.id,
    telemetryRevision: telemetryRevision(telemetry),
    source: source!,
    rows,
    sha256: createHash('sha256').update(jsonl).digest('hex'),
  };
  return {
    demonstrations: {
      schemaVersion: 1,
      sourceRunId: trainingData.sourceRunId,
      telemetryRevision: trainingData.telemetryRevision,
      source: trainingData.source,
      sha256: trainingData.sha256,
      jsonl,
    },
    trainingData,
  };
}

export async function loadTrainingDemonstrations(
  sourceRunId: string,
  targetManifest: Sim2RealModelManifest,
  owner?: string,
): Promise<ReturnType<typeof buildTrainingDemonstrations>> {
  const run = await getSim2RealRun(sourceRunId, owner);
  const sourceModel = run ? await getSim2RealModel(run.modelId, owner) : null;
  if (!run || !sourceModel) {
    throw new TrainingDemonstrationError(
      'SIM2REAL_DEMONSTRATION_NOT_FOUND',
      '演示来源 Run 不存在，或不属于当前账号。',
      404,
    );
  }
  return buildTrainingDemonstrations({
    run,
    sourceContract: sourceModel.manifest.contract,
    targetContract: targetManifest.contract,
    telemetry: await listSim2RealTelemetry(sourceRunId, owner, SIM2REAL_TELEMETRY_RECORD_CAP),
  });
}
