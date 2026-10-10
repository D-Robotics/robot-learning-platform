import { createHash } from 'node:crypto';
import type {
  Sim2RealDemonstrations,
  Sim2RealModelRecord,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';
import { getSim2RealModel, getSim2RealRun, listSim2RealTelemetry } from './sim2real-store.js';

export class DemonstrationInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_CHUNKS = 16;
const MAX_JSONL_BYTES = 512 * 1024;
const MAX_SAMPLES = 20_000;

/** Resolve recorded bytes through the existing owner-scoped telemetry store. */
export async function resolveRecordedDemonstrations(input: {
  training?: Sim2RealTrainingSpec;
  model: Sim2RealModelRecord;
  owner?: string;
  projectId?: string;
}): Promise<Sim2RealDemonstrations | undefined> {
  const training = input.training;
  const imitation = training?.engine === 'act' || training?.engine === 'diffusion-policy';
  const refuse = (code: string, message: string): never => {
    throw new DemonstrationInputError(code, message);
  };
  if (!imitation) {
    if (training?.demonstrationRunId || training?.syntheticSmoke)
      refuse(
        'SIM2REAL_DEMONSTRATION_ENGINE_INVALID',
        '示教输入仅支持 ACT 或 Diffusion Policy，请选择对应引擎。',
      );
    return undefined;
  }
  if (training.syntheticSmoke === true) return undefined;
  const runId = training.demonstrationRunId;
  if (!runId)
    return refuse(
      'SIM2REAL_DEMONSTRATION_REQUIRED',
      'ACT / Diffusion Policy 需要选择示教 Run；协议演示必须明确勾选 syntheticSmoke 并使用 smoke 档位。',
    );
  const source = await getSim2RealRun(runId, input.owner);
  if (!source || source.mock === true)
    return refuse(
      'SIM2REAL_DEMONSTRATION_SOURCE_INVALID',
      '示教 Run 不存在、不属于当前账号或是 Mock 协议演示。',
    );
  if (input.projectId !== source.projectId)
    refuse(
      'SIM2REAL_DEMONSTRATION_PROJECT_MISMATCH',
      '示教 Run 必须属于当前项目，请切换项目或重新导入示教。',
    );
  const sourceModel = await getSim2RealModel(source.modelId, input.owner);
  const contract = input.model.manifest.contract;
  if (
    !sourceModel ||
    sourceModel.manifest.contract.id !== contract.id ||
    sourceModel.manifest.contract.observationSize !== contract.observationSize ||
    sourceModel.manifest.contract.actionSize !== contract.actionSize
  )
    refuse(
      'SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH',
      '示教来源的观测 / 动作契约与当前模型不一致。',
    );
  if (contract.observationLayout?.some((slot) => 'modality' in slot && slot.modality === 'image'))
    refuse(
      'SIM2REAL_DEMONSTRATION_IMAGE_UNSUPPORTED',
      '工作台示教训练当前支持向量观测；图像示教请使用引擎 CLI 的明确图像输入。',
    );
  const chunks = await listSim2RealTelemetry(runId, input.owner, MAX_CHUNKS + 1);
  if (chunks.length > MAX_CHUNKS)
    refuse(
      'SIM2REAL_DEMONSTRATION_TOO_LARGE',
      '示教分片超过 16 个，请导入一份较小的完整回合数据集。',
    );
  if (chunks.some((chunk) => chunk.source === 'demo-fixture'))
    refuse(
      'SIM2REAL_DEMONSTRATION_SOURCE_INVALID',
      '演示夹具不能作为用户示教数据，请导入或录制自己的轨迹。',
    );
  const lines: string[] = [];
  let bytes = 0,
    steps = 0,
    episodeCount = 0;
  for (const chunk of chunks)
    for (const sample of chunk.samples || []) {
      if (sample.event) continue;
      const obs = sample.observation,
        action = sample.action;
      if (
        !Array.isArray(obs) ||
        !Array.isArray(action) ||
        obs.length !== contract.observationSize ||
        action.length !== contract.actionSize ||
        [...obs, ...action].some((value) => typeof value !== 'number' || !Number.isFinite(value))
      )
        refuse(
          'SIM2REAL_DEMONSTRATION_DIMENSIONS_INVALID',
          '示教每帧必须有与模型一致的有限数值 observation 和 action。',
        );
      if (sample.done !== undefined && typeof sample.done !== 'boolean')
        refuse('SIM2REAL_DEMONSTRATION_EPISODES_INVALID', '示教 done 必须是布尔值。');
      const done = sample.done === true || sample.fall === true;
      const line = JSON.stringify({ type: 'step', observation: obs, action, done });
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > MAX_JSONL_BYTES || lines.length >= MAX_SAMPLES)
        refuse(
          'SIM2REAL_DEMONSTRATION_TOO_LARGE',
          '示教超过 512 KiB 或 20000 帧；请导入较小的完整回合，平台不会截断数据。',
        );
      lines.push(line);
      steps += 1;
      if (done) {
        if (steps < 4)
          refuse(
            'SIM2REAL_DEMONSTRATION_EPISODES_INVALID',
            '动作分块示教要求每个完整回合至少 4 帧。',
          );
        episodeCount += 1;
        steps = 0;
      }
    }
  if (episodeCount < 8 || steps !== 0)
    refuse(
      'SIM2REAL_DEMONSTRATION_EPISODES_INVALID',
      '请提供至少 8 个完整示教回合，每回合至少 4 帧，并用 done / fall 标记结束；平台不会拼接或伪造回合。',
    );
  const jsonl = lines.join('\n') + '\n';
  return {
    sourceRunId: runId,
    sha256: createHash('sha256').update(jsonl).digest('hex'),
    jsonl,
    sampleCount: lines.length,
    episodeCount,
  };
}
