import {
  ORIGINMAN_WORKSHOP_ENGINE,
  ORIGINMAN_WORKSHOP_TASK,
  matchesOriginmanWorkshopContract,
} from '../../shared/originman-workshop.js';
import { SIM2REAL_PRODUCT_PROFILES } from '../../shared/sim2real.js';
import type {
  Sim2RealComputeResource,
  Sim2RealModelRecord,
  Sim2RealRunRecord,
} from '../../shared/sim2real.js';

type Resource = Sim2RealComputeResource & { mock?: boolean; engines?: string[] };

interface Input {
  model?: Sim2RealModelRecord;
  taskId?: string;
  computeResourceId?: string;
  computeResources?: Resource[];
  runs: Sim2RealRunRecord[];
  desktopComputeResourceIds?: string[];
}

/** Guidance only: submission, resource and deployment checks remain authoritative. */
export function buildOriginmanLearningGuide(
  input: Input,
  healthFresh: (resource: Resource) => boolean,
  workbench: unknown = {},
) {
  const resources = input.computeResources ?? [];
  const compatible = resources.filter((r) => r.engines?.includes(ORIGINMAN_WORKSHOP_ENGINE));
  const ready = compatible.filter((r) => healthFresh(r) && r.mock === false);
  const selected = input.computeResourceId
    ? resources.find((r) => r.id === input.computeResourceId)
    : ready.length === 1
      ? ready[0]
      : undefined;
  const relay =
    selected?.source === 'local-agent' && !input.desktopComputeResourceIds?.includes(selected.id);
  const taskId = input.taskId ?? ORIGINMAN_WORKSHOP_TASK;
  const taskAvailable = taskId === ORIGINMAN_WORKSHOP_TASK;
  const shapeCompatible = Boolean(
    input.model && matchesOriginmanWorkshopContract(input.model.manifest.contract),
  );
  const fresh = Boolean(selected && healthFresh(selected));
  const engineRegistered = Boolean(selected?.engines?.includes(ORIGINMAN_WORKSHOP_ENGINE));
  const canSubmit = Boolean(
    taskAvailable &&
    shapeCompatible &&
    fresh &&
    selected?.mock === false &&
    engineRegistered &&
    !relay,
  );
  const latest = input.runs
    .filter(
      (r) =>
        r.modelId === input.model?.id &&
        r.taskId === ORIGINMAN_WORKSHOP_TASK &&
        r.training?.engine === ORIGINMAN_WORKSHOP_ENGINE &&
        r.training.originmanWorkshop?.phase === 'train',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const running = Boolean(latest && ['queued', 'running'].includes(latest.status));
  const trained = Boolean(
    latest?.status === 'completed' &&
    latest.mock === false &&
    ['local', 'robogo'].includes(latest.backend) &&
    latest.artifact?.artifactRef &&
    /^[a-f0-9]{64}$/.test(latest.artifact?.sha256 ?? ''),
  );
  const preview =
    shapeCompatible && taskAvailable && selected && !relay
      ? {
          tool: 'rdk_training_submit',
          arguments: {
            modelId: input.model!.id,
            computeResourceId: selected.id,
            taskId: ORIGINMAN_WORKSHOP_TASK,
            backend: 'local',
            engine: ORIGINMAN_WORKSHOP_ENGINE,
            algorithm: 'sac',
            numEnvs: 4,
            profile: 'standard',
            maxIterations: 1954,
            originmanWorkshop: {
              phase: 'train',
              timesteps: 500000,
              seed: 7,
              pushMaxForce: 8.1,
              device: 'cuda',
            },
          },
          requiresResourceCheck: true,
          autoExecute: false,
        }
      : null;
  const nextAction = running
    ? {
        tool: 'rdk_training_status',
        arguments: { runId: latest!.id },
        reason: '已有训练，查询原 Run，不重复提交。',
      }
    : !shapeCompatible || !taskAvailable
      ? {
          tool: 'rdk_workshop_catalog',
          arguments: { robot: 'originman' },
          reason: '先选择专用 14→2 恢复契约和任务；不套用通用底盘任务。',
        }
      : !selected
        ? {
            tool: 'rdk_compute_resources_list',
            arguments: {},
            reason: '明确选择支持 OriginMan 的执行资源；不自动改用其他机器人 Worker。',
          }
        : !fresh
          ? {
              tool: 'rdk_compute_resource_test',
              arguments: { computeResourceId: selected.id },
              reason: '先刷新所选资源健康状态。',
            }
          : !canSubmit
            ? {
                tool: 'rdk_compute_resources_list',
                arguments: {},
                reason: '所选资源必须支持 OriginMan、非 Mock 且无需未连接的浏览器 Relay。',
              }
            : {
                tool: 'rdk_training_preflight',
                arguments: { taskId, computeResourceId: selected.id },
                reason: '先检查实际依赖、模型和 CUDA；可从零训练，不要求已有训练权重。',
              };
  return {
    schemaVersion: 1,
    product: SIM2REAL_PRODUCT_PROFILES.originman,
    scope: { modelId: input.model?.id ?? null, taskId, computeResourceId: selected?.id ?? null },
    workbench,
    contract: input.model?.manifest.contract ?? null,
    tasks: [
      {
        id: ORIGINMAN_WORKSHOP_TASK,
        label: 'OriginMan 原地受扰恢复',
        available: true,
        shapeCompatible,
        engine: ORIGINMAN_WORKSHOP_ENGINE,
      },
    ],
    task: taskAvailable
      ? { id: taskId, available: true, shapeCompatible, engine: ORIGINMAN_WORKSHOP_ENGINE }
      : null,
    taskPackAvailable: taskAvailable,
    adaptation: {
      dedicatedTaskPacksAvailable: true,
      physicalConfigurationVerified: false,
      note: '专用站立恢复仿真；未验证步态、视觉跟随或真实本体。',
    },
    reference: {
      available: null,
      optional: true,
      source: 'instructor-reference',
      entryUrl: './?robot=originman#train/submit',
      verifyTool: 'rdk_workshop_catalog',
      note: '课程目录单独校验课前回放；参考材料和已有训练制品都不是从零训练的前提。',
    },
    training: {
      defaultDevice: 'cuda',
      supportedDevices: ['cuda', 'cpu'],
      selectedResource: selected
        ? {
            id: selected.id,
            name: selected.name,
            source: selected.source,
            status: selected.status,
            mock: selected.mock ?? null,
            engines: selected.engines ?? [],
            healthFresh: fresh,
          }
        : null,
      resources: compatible.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        mock: r.mock ?? null,
        engines: r.engines ?? [],
        healthFresh: healthFresh(r),
      })),
      browserRelayRequired: Boolean(relay),
      canSubmitRealTraining: canSubmit,
      engineRegistered,
      dependenciesVerified: false,
      datasetRequiredForImitation: true,
      datasetRequiredForPpo: false,
      existingArtifactRequiredForTraining: false,
      preview,
    },
    latestResult: latest
      ? {
          runId: latest.id,
          status: latest.status,
          source: trained ? 'trained-artifact' : 'unverified',
          artifactRef: latest.artifact?.artifactRef ?? null,
        }
      : null,
    nextAction,
    readiness: [
      {
        stage: 'contract',
        status: shapeCompatible ? 'ready' : 'blocked',
        reason: '使用专用恢复契约。',
        view: 'prepare',
      },
      {
        stage: 'reference',
        status: 'unverified',
        optional: true,
        reason: '课程目录独立校验课前回放，不阻断从零训练。',
        view: 'train',
      },
      {
        stage: 'training-resource',
        status: canSubmit ? 'ready' : 'blocked',
        reason: nextAction.reason,
        view: 'resources',
      },
      {
        stage: 'trained-artifact',
        status: trained ? 'ready' : running ? 'running' : 'unverified',
        optional: true,
        reason: '没有已有权重可以从零训练；完成后仍需单独评测。',
        view: 'progress',
      },
      {
        stage: 'sim2real',
        status: 'blocked',
        reason: '仅仿真，缺少真实本体标定和运动证据。',
        view: 'evaluate',
      },
      {
        stage: 'deployment',
        status: 'blocked',
        reason: 'OriginMan 仿真制品没有硬件部署资格。',
        view: 'deploy',
      },
    ],
    workflow: [
      {
        stage: 'discover',
        tool: 'rdk_workshop_catalog',
        purpose: '读取 OriginMan 契约及独立的课前参考材料。',
      },
      {
        stage: 'resource',
        tool: 'rdk_training_prepare',
        purpose: '明确选择资源，刷新健康状态并检查 OriginMan 任务环境。',
      },
      {
        stage: 'train',
        tool: 'rdk_training_submit',
        purpose: '用户授权后提交 SAC 训练，默认 CUDA；CPU 必须显式选择。',
      },
      {
        stage: 'observe',
        tool: 'rdk_training_status',
        purpose: '查询原 Run，核对实际参数设备、梯度更新与制品摘要。',
      },
      {
        stage: 'evaluate',
        tool: 'rdk_training_submit',
        requiresAuthorization: true,
        purpose: '另建 phase=evaluate 的 Run，sourceRunId 指向本组完成的训练，冻结原配置。',
      },
      {
        stage: 'compare',
        tool: 'rdk_training_status',
        purpose: '读取评测 Run 的全部 31 条件及回放；失败同样保留。',
      },
    ],
    simulationOnly: true,
    hardwareEligible: false,
  };
}
