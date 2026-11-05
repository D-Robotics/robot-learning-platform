/** Durable references only. Platform reads remain the authority for identity and Run access. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 96,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
};
export const EXPERIMENT_TOOLS = [
  {
    name: 'rdk_experiment_remember',
    description:
      '为当前实验保存已提交的训练Run引用，可附同源评测Run。按当前正式账号和平台隔离，不提交训练、不选择最新任务；同一标识不可改绑另一训练。不要把凭据作为标识。',
    inputSchema: {
      type: 'object',
      required: ['contextId', 'runId'],
      additionalProperties: false,
      properties: { contextId: idSchema, runId: idSchema, evaluationRunId: idSchema },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'rdk_experiment_resume',
    description:
      '按明确实验标识恢复原训练和评测，实时重查当前账号权限、状态与策略来源，返回下一步和回放入口。不重新提交、不操作设备、不把执行完成当作效果达标。',
    inputSchema: {
      type: 'object',
      required: ['contextId'],
      additionalProperties: false,
      properties: { contextId: idSchema },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];
function validate(operation, input) {
  if (
    !['remember', 'resume'].includes(operation) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    throw new Error('无效实验操作。');
  const allowed =
    operation === 'remember' ? ['contextId', 'runId', 'evaluationRunId'] : ['contextId'];
  for (const [key, value] of Object.entries(input)) {
    if (
      !allowed.includes(key) ||
      typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)
    )
      throw new Error('仅接受明确、非空且不含路径的实验与Run标识。');
  }
  if (!input.contextId || (operation === 'remember' && !input.runId))
    throw new Error('缺少实验或训练Run标识。');
}
function checkPrivate(info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error('实验目录或记录不是私有常规路径。');
  if (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid()))
    throw new Error('实验目录和记录必须由当前用户拥有且禁止其他用户访问。');
}
function read(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  checkPrivate(info, false);
  if (info.size > 4096) throw new Error('实验记录超过读取预算。');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value.runId)
  )
    throw new Error('实验记录格式不受支持。');
  return value;
}
function createReference(file, runId) {
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, runId }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (read(file)?.runId !== runId)
    throw new Error('该实验已绑定其他训练或评测；请为新实验使用新标识。');
}
function evidence(run) {
  return run.metrics?.originmanWorkshop;
}
function validatePair(training, evaluation) {
  const sources = [
    evidence(evaluation)?.sourceRunId,
    evaluation.sourceRunId,
    evaluation.training?.originmanWorkshop?.sourceRunId,
  ].filter((value) => value != null);
  const phases = [
    evidence(evaluation)?.phase,
    evaluation.training?.originmanWorkshop?.phase,
  ].filter((value) => value != null);
  if (
    !sources.length ||
    sources.some((source) => source !== training.runId) ||
    phases.some((phase) => phase !== 'evaluate') ||
    evaluation.modelId !== training.modelId
  )
    throw new Error('评测来源与本实验训练不一致，不保存或展示为同一实验。');
  const trainSha = evidence(training)?.policySha256;
  const evalSha = evidence(evaluation)?.policySha256;
  const pending = ['queued', 'running'].includes(evaluation.status);
  if (
    (trainSha || evalSha) &&
    (!/^[a-f0-9]{64}$/.test(trainSha ?? '') ||
      ((evalSha || evaluation.status === 'completed') && trainSha !== evalSha))
  )
    throw new Error('评测策略摘要与训练不一致。');
  return {
    executionVerified:
      evaluation.status === 'completed' && Boolean(trainSha) && trainSha === evalSha,
    note: pending
      ? '暂按平台请求中的明确父Run保存引用；执行摘要尚待终态重验。'
      : evaluation.status === 'completed' && trainSha && trainSha === evalSha
        ? '本次查询已重新核对父Run与策略摘要。'
        : '父Run引用已核对；尚无匹配的完成执行摘要。保留原评测状态和失败原因。',
  };
}
export async function experimentContext(
  operation,
  input,
  call,
  {
    directory = path.join(os.homedir(), '.config', 'rdk-robot-learning-platform', 'experiments'),
  } = {},
) {
  validate(operation, input);
  const status = await call('rdk_platform_status', {});
  if (
    status?.ok !== true ||
    status.session?.authenticated !== true ||
    typeof status.session.accountId !== 'string' ||
    !status.session.accountId.trim()
  )
    throw new Error('未取得当前正式账号身份，不能恢复跨进程实验。请先核对登录。');
  const base = new URL(status.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('平台地址不适合生成实验入口。');
  const baseUrl = base.toString().replace(/\/+$/, '');
  const scope = digest(JSON.stringify([baseUrl, status.session.accountId, input.contextId]));
  if (operation === 'remember') fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(directory))
    throw new Error('当前平台和账号下未保存此实验；请明确选择已有Run，不自动选最新任务。');
  checkPrivate(fs.lstatSync(directory), true);
  const trainingFile = path.join(directory, scope + '.json');
  const evaluationFile = path.join(directory, scope + '.evaluation.json');
  const savedTraining = read(trainingFile);
  const savedEvaluation = read(evaluationFile);
  if (operation === 'resume' && !savedTraining)
    throw new Error('当前平台和账号下未保存此实验；请明确选择已有Run，不自动选最新任务。');
  if (savedTraining && input.runId && input.runId !== savedTraining.runId)
    throw new Error('该实验已绑定其他训练；新训练请使用新的实验标识。');
  if (savedEvaluation && input.evaluationRunId && input.evaluationRunId !== savedEvaluation.runId)
    throw new Error('该实验已有其他评测；新的评测请使用新的实验标识。');
  const runId = savedTraining?.runId ?? input.runId;
  const evaluationRunId = savedEvaluation?.runId ?? input.evaluationRunId;
  const getRun = async (id, requireParent = false) => {
    const result = await call('rdk_training_status', { runId: id });
    if (
      result?.runId !== id ||
      typeof result.status !== 'string' ||
      !result.status ||
      typeof result.modelId !== 'string' ||
      !result.modelId
    )
      throw new Error('平台未返回所请求Run的明确身份与状态。');
    // Some platform versions omit request provenance from compact status replies.
    // Hydrate only the exact Run; never infer a parent from a recent/global Run.
    if (
      requireParent &&
      !evidence(result)?.sourceRunId &&
      !result.sourceRunId &&
      !result.training?.originmanWorkshop?.sourceRunId
    ) {
      const full = (await call('rdk_lineage_get', { runId: id }))?.lineage?.run;
      if (full?.id !== id || full.modelId !== result.modelId || full.status !== result.status)
        throw new Error('血缘与当前Run身份、模型或状态不一致；请重新读取原Run，不重新提交。');
      validatePair(training, { ...full, runId: id });
      return {
        ...full,
        ...result,
        training: result.training ?? full.training,
        sourceRunId: result.sourceRunId ?? full.sourceRunId,
      };
    }
    return result;
  };
  const training = await getRun(runId);
  if (
    evidence(training)?.phase === 'evaluate' ||
    evidence(training)?.sourceRunId ||
    training.training?.originmanWorkshop?.phase === 'evaluate'
  )
    throw new Error('请绑定训练Run，不能将评测Run当作训练。');
  const evaluation = evaluationRunId ? await getRun(evaluationRunId, true) : null;
  const association = evaluation ? validatePair(training, evaluation) : null;
  const finalIdentity = await call('rdk_platform_status', {});
  if (
    finalIdentity?.ok !== true ||
    finalIdentity.session?.authenticated !== true ||
    finalIdentity.session.accountId !== status.session.accountId ||
    new URL(finalIdentity.baseUrl).toString().replace(/\/+$/, '') !== baseUrl
  )
    throw new Error('查询期间平台或账号身份发生变化；未保存或返回实验，请确认当前连接后重试查询。');
  if (operation === 'remember') {
    createReference(trainingFile, runId);
    if (evaluationRunId) createReference(evaluationFile, evaluationRunId);
  }
  const failed = ['blocked', 'failed', 'cancelled'].includes(training.status);
  const evaluationFailed = ['blocked', 'failed', 'cancelled'].includes(evaluation?.status);
  const evaluationEvidence = evaluation ? evidence(evaluation) : null;
  const video = evaluationEvidence?.video;
  const canReplay =
    training.status === 'completed' &&
    association?.executionVerified === true &&
    evaluation?.status === 'completed' &&
    evaluationEvidence?.phase === 'evaluate' &&
    !evaluationEvidence.videoError &&
    /^[a-f0-9]{64}$/.test(video?.sha256 ?? '') &&
    Number.isSafeInteger(video?.bytes) &&
    video.bytes > 0;
  return {
    contextId: input.contextId,
    observedAt: new Date().toISOString(),
    training,
    evaluation,
    association,
    playback: {
      state: canReplay
        ? 'recorded'
        : evaluationFailed
          ? 'blocked'
          : evaluation?.status === 'completed'
            ? 'missing'
            : 'pending',
      endpointVerified: false,
      verifiedInPlayer: false,
      reason: canReplay
        ? '平台曾记录视频字节数与摘要；本次未检查媒体端点，原Worker离线或文件不可读仍可能导致失败。'
        : (evaluationEvidence?.videoError ??
          '尚无可用视频的完整平台回执；不生成回放入口，不自动重交评测。'),
    },
    quality: {
      clearGain:
        evaluation?.status === 'completed' ? (evaluationEvidence?.clearGain ?? null) : null,
      hardwareVerified: false,
      note: '执行完成与质量达标分别判断；本工具不验证视频实际播放或真机效果。',
    },
    links: {
      workbench: baseUrl + '/#train',
      exactRunSelected: false,
      ...(canReplay
        ? {
            video:
              baseUrl +
              '/api/v1/duck/runs/' +
              encodeURIComponent(evaluationRunId) +
              '/workshop-video?format=webm',
          }
        : {}),
      note: '工作台入口不保证自动选中Run。视频入口仍由平台认证与文件状态决定；不复制Cookie、不声称已打开或播放。',
    },
    nextAction: failed
      ? '先读取失败原因与原Run日志，不自动重新提交。'
      : training.status !== 'completed'
        ? '继续查询本实验原Run；等待或断线不代表需要重交训练。'
        : !evaluation
          ? '训练已完成；按原训练参数调用平台评测工具，并将返回的同源评测Run关联到此实验。'
          : evaluationFailed
            ? '评测未成功结束：先查看原评测失败原因与日志，不自动重新提交。'
            : evaluation.status !== 'completed'
              ? '继续查询已关联评测，不自动重交。'
              : !canReplay
                ? '评测已完成；视频回执缺失或生成失败，查看原评测日志，不自动重交。'
                : '核对质量结论；用户要求时打开视频候选入口，检查当前访问与播放。端点失败保留原错误并排查原Worker，不自动重交。',
    suggestedRead: {
      tool: 'rdk_run_logs',
      arguments: { runId: failed || !evaluation ? runId : evaluationRunId },
    },
    execution: {
      trainingSubmitted: false,
      evaluationSubmitted: false,
      browserOpened: false,
      hardwareCommandSent: false,
    },
  };
}
