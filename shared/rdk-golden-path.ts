import type {
  Sim2RealDatasetRecord,
  Sim2RealDeploymentRecord,
  Sim2RealEvaluationRecord,
  Sim2RealProjectRecord,
  Sim2RealRunRecord,
} from './sim2real.js';

/** The product's one canonical path from a task to measured RDK feedback. */
export const RDK_GOLDEN_PATH_SCHEMA_VERSION = 1 as const;

export type RdkGoldenPathStageKey =
  'task' | 'dataset' | 'train' | 'evaluate' | 'deploy' | 'feedback';
export type RdkGoldenPathStageState =
  'pending' | 'ready' | 'running' | 'succeeded' | 'blocked' | 'failed';

export interface RdkGoldenPathStage {
  key: RdkGoldenPathStageKey;
  label: string;
  state: RdkGoldenPathStageState;
  summary: string;
  refs: string[];
}

export interface RdkGoldenPathSnapshot {
  schemaVersion: typeof RDK_GOLDEN_PATH_SCHEMA_VERSION;
  scope: {
    projectId?: string;
    modelId?: string;
    taskId?: string;
  };
  stages: RdkGoldenPathStage[];
  progress: { completed: number; total: number; percent: number };
  nextAction: { stage: RdkGoldenPathStageKey; label: string; reason: string } | null;
  readyForRdkPreflight: boolean;
}

type Inputs = {
  project?: Sim2RealProjectRecord;
  modelId?: string;
  taskId?: string;
  datasets: Sim2RealDatasetRecord[];
  runs: Sim2RealRunRecord[];
  evaluations: Sim2RealEvaluationRecord[];
  deployments: Sim2RealDeploymentRecord[];
};

const labels: Record<RdkGoldenPathStageKey, string> = {
  task: '选择任务',
  dataset: '准备数据',
  train: '训练或接入模型',
  evaluate: '真机/仿真评测',
  deploy: '部署到 RDK',
  feedback: '失败回流',
};

function newest<T extends { createdAt: string; updatedAt?: string }>(items: T[]): T | undefined {
  return items
    .slice()
    .sort(
      (a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt),
    )[0];
}

function stage(
  key: RdkGoldenPathStageKey,
  state: RdkGoldenPathStageState,
  summary: string,
  refs: string[] = [],
): RdkGoldenPathStage {
  return { key, label: labels[key], state, summary, refs };
}

/**
 * Derive the user-facing path from persisted records. This is deliberately a
 * pure function: local storage, PostgreSQL, and a future RDK Studio adapter
 * all produce the same answer and cannot invent a second workflow state.
 */
export function deriveRdkGoldenPath(input: Inputs): RdkGoldenPathSnapshot {
  const projectModelIds = input.project ? new Set(input.project.modelIds) : undefined;
  const projectDatasetIds = input.project ? new Set(input.project.datasetIds) : undefined;
  const modelId =
    input.modelId || (projectModelIds?.size === 1 ? [...projectModelIds][0] : undefined);
  const taskId = input.taskId || newest(input.runs)?.taskId || newest(input.evaluations)?.taskId;

  const datasets = input.datasets.filter(
    (dataset) => !projectDatasetIds || projectDatasetIds.has(dataset.id),
  );
  const runs = input.runs.filter(
    (run) =>
      (!projectModelIds || projectModelIds.has(run.modelId)) &&
      (!modelId || run.modelId === modelId) &&
      (!taskId || !run.taskId || run.taskId === taskId),
  );
  const evaluations = input.evaluations.filter(
    (evaluation) =>
      (!modelId || evaluation.modelId === modelId) &&
      (!taskId || !evaluation.taskId || evaluation.taskId === taskId),
  );
  const deployments = input.deployments.filter(
    (deployment) => !modelId || deployment.modelId === modelId,
  );

  const latestRun = newest(runs);
  const latestEvaluation = newest(evaluations);
  const latestDeployment = newest(deployments);
  const datasetRefs = datasets.map((item) => item.id);

  const taskStage = taskId
    ? stage('task', 'succeeded', `已选择任务 ${taskId}`, [taskId])
    : stage('task', 'ready', '选择一个 RDK 任务包（建议先从目标点导航开始）');

  let datasetStage: RdkGoldenPathStage;
  if (!datasets.length) datasetStage = stage('dataset', 'blocked', '需要导入或登记一个数据集');
  else if (datasets.some((item) => item.status === 'revoked')) {
    datasetStage = stage('dataset', 'blocked', '数据集已撤销，请选择仍有效的版本', datasetRefs);
  } else if (datasets.every((item) => item.status === 'ready' || !item.status)) {
    datasetStage = stage('dataset', 'succeeded', `${datasets.length} 个数据集已就绪`, datasetRefs);
  } else {
    datasetStage = stage('dataset', 'ready', '数据集已登记，完成导入校验后继续', datasetRefs);
  }

  let trainStage: RdkGoldenPathStage;
  if (!latestRun) trainStage = stage('train', 'ready', '启动本地/GPU 训练，或接入已有模型');
  else if (latestRun.status === 'running' || latestRun.status === 'queued') {
    trainStage = stage('train', 'running', '训练正在运行，等待制品生成', [latestRun.id]);
  } else if (latestRun.status === 'completed') {
    trainStage = stage('train', 'succeeded', '训练已完成并产生可追溯 Run', [latestRun.id]);
  } else if (latestRun.status === 'failed' || latestRun.status === 'blocked') {
    trainStage = stage(
      'train',
      latestRun.status === 'failed' ? 'failed' : 'blocked',
      latestRun.summary,
      [latestRun.id],
    );
  } else trainStage = stage('train', 'ready', latestRun.summary, [latestRun.id]);

  let evaluateStage: RdkGoldenPathStage;
  if (!latestEvaluation) evaluateStage = stage('evaluate', 'pending', '训练完成后运行固定评测信封');
  else if (latestEvaluation.status === 'passed' && !latestEvaluation.stale) {
    evaluateStage = stage('evaluate', 'succeeded', latestEvaluation.summary, [latestEvaluation.id]);
  } else if (latestEvaluation.status === 'running' || latestEvaluation.status === 'pending') {
    evaluateStage = stage('evaluate', 'running', latestEvaluation.summary, [latestEvaluation.id]);
  } else {
    evaluateStage = stage(
      'evaluate',
      latestEvaluation.status === 'invalid' ? 'blocked' : 'failed',
      latestEvaluation.summary,
      [latestEvaluation.id],
    );
  }

  let deployStage: RdkGoldenPathStage;
  if (!latestDeployment)
    deployStage = stage('deploy', 'pending', '评测通过后创建 RDK 只读预检计划');
  else if (['completed', 'ready'].includes(latestDeployment.status)) {
    deployStage = stage(
      'deploy',
      latestDeployment.status === 'completed' ? 'succeeded' : 'ready',
      latestDeployment.summary,
      [latestDeployment.id],
    );
  } else if (['running', 'planned'].includes(latestDeployment.status)) {
    deployStage = stage('deploy', 'running', latestDeployment.summary, [latestDeployment.id]);
  } else {
    deployStage = stage(
      'deploy',
      latestDeployment.status === 'blocked' ? 'blocked' : 'failed',
      latestDeployment.summary,
      [latestDeployment.id],
    );
  }

  const hasAttestedFeedback =
    Boolean(latestEvaluation?.attested && latestEvaluation.deviceId) ||
    Boolean(latestDeployment?.verification && latestDeployment.verification.mock !== true);
  const feedbackStage = hasAttestedFeedback
    ? stage(
        'feedback',
        'succeeded',
        '已收到 RDK 板端证据，可将失败轨迹回流训练',
        latestEvaluation?.id ? [latestEvaluation.id] : [],
      )
    : latestDeployment?.status === 'failed' || latestDeployment?.status === 'blocked'
      ? stage('feedback', 'blocked', '部署未通过，先查看预检原因并修复')
      : stage('feedback', 'pending', '真机运行后上传遥测，失败轨迹会绑定回 Run');

  const stages = [taskStage, datasetStage, trainStage, evaluateStage, deployStage, feedbackStage];
  const completed = stages.filter((item) => item.state === 'succeeded').length;
  const next = stages.find((item) => item.state !== 'succeeded');
  return {
    schemaVersion: RDK_GOLDEN_PATH_SCHEMA_VERSION,
    scope: {
      ...(input.project?.id ? { projectId: input.project.id } : {}),
      ...(modelId ? { modelId } : {}),
      ...(taskId ? { taskId } : {}),
    },
    stages,
    progress: {
      completed,
      total: stages.length,
      percent: Math.round((completed / stages.length) * 100),
    },
    nextAction: next ? { stage: next.key, label: next.label, reason: next.summary } : null,
    readyForRdkPreflight: evaluateStage.state === 'succeeded' && trainStage.state === 'succeeded',
  };
}
