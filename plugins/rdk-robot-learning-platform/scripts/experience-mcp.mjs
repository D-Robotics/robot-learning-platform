#!/usr/bin/env node
/** Add read-only experience composition while preserving the installed upstream MCP. */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { danceCoaching } from './dance-coaching.mjs';
import {
  connectMcp,
  prepareExperience,
  readToolResult,
  isDirectInvocation,
  workspaceReferenceEntry,
} from './experience.mjs';
import {
  WORKFLOW_TOOLS,
  inspectWorkflow,
  prepareTraining,
  readOriginmanEvaluation,
} from './workflow-inspection.mjs';
import { enrichToolError } from './plugin-errors.mjs';
import { AUTH_TOOLS } from './plugin-auth.mjs';
import { SHORT_TRAINING_TOOLS, shortTraining } from './short-training.mjs';
import { EXPERIMENT_TOOLS, experimentContext } from './experiment-context.mjs';
import {
  UI_HTML,
  UI_URI,
  UI_MIME,
  UI_TOOLS,
  uiSupported,
  uiMetadata,
  uiResource,
} from './mcp-app-resource.mjs';
import {
  COURSE_BRIEF_TOOL,
  courseBrief,
  TRAINING_CHOICE_TOOL,
  LEARNING_GUIDE_TOOL,
  ORIGINMAN_DANCE_DRAFT_TOOL,
  originmanDanceDraft,
  learningGuide,
  validateLearningGuideArgs,
  trainingChoice,
  ORIGINMAN_COURSE,
  ORIGINMAN_COURSE_INSTRUCTIONS,
  courseToolHint,
  courseLinks,
  sectionTitles,
} from './workshop-course.mjs';

import { ROBOT_ONBOARDING_TOOLS, onboardingGuide, assessOnboarding } from './robot-onboarding.mjs';
import { CLASSROOM_TOOLS, classroomGuide } from './classroom-guide.mjs';
import {
  STUDIO_WORKSHOP_NAVIGATION,
  WORKSHOP_TOOLS,
  workshopEntry,
  workshopPageNavigation,
  workshopPreview,
} from './workshop-entry.mjs';
import { DEVELOPMENT_TARGET_TOOL, developmentTargets } from './development-targets.mjs';
import {
  DANCE_ACCEPTANCE_TOOL,
  DANCE_EVALUATION_TOOLS,
  acceptDanceSimulation,
  createDanceEvaluationReader,
  danceEvaluation,
} from './dance-evaluation.mjs';
import {
  DANCE_TRAINING_TOOLS,
  trainOriginmanDance,
  recoverDanceSubmission,
} from './dance-training.mjs';
import {
  createDanceIteration,
  createDanceGoalContinuation,
  DANCE_ITERATION_TOOL,
  matchesDanceIterationGpu,
} from './dance-iteration.mjs';
import {
  WORKSPACE_EVIDENCE_INSTRUCTIONS,
  WORKSPACE_EVIDENCE_TOOL,
  workspaceLink,
} from './workspace-evidence.mjs';

/** Learner text uses the same verified facts; full diagnostics remain structured. */
export function experimentStudentReply(payload) {
  const result = payload.experiment ?? payload;
  const training = result.training,
    evaluation = result.evaluation;
  if (!training) return null;
  const failed = (status) => ['failed', 'blocked', 'cancelled', 'canceled'].includes(status);
  const experimentLink = result.links?.experiment
    ? `\n[查看本轮实验](${result.links.experiment})`
    : '';
  if (failed(training.status))
    return '本轮训练未成功。先打开原训练日志，查看失败步骤和最后一条错误。' + experimentLink;
  if (failed(evaluation?.status))
    return '本轮评测未成功。先打开原评测日志，核对失败条件和本轮权重。' + experimentLink;
  if (payload.stopWorkflow) return '流程已暂停。先查看已提交的原任务状态。';
  if (training.status !== 'completed') return '训练进行中，正在等待本次任务完成。';
  if (!evaluation) return '训练已完成。可从本轮实验页评测这条策略。' + experimentLink;
  if (evaluation.status !== 'completed') return '训练已完成，正在评测同一策略。';
  if (result.association?.executionVerified !== true)
    return '任务已结束，来源尚待核对。暂不展示效果结论。';
  const quality =
    result.quality?.clearGain === true
      ? '本轮仿真达到改善标准。'
      : result.quality?.clearGain === false
        ? '本轮仿真未达到改善标准。先在对比表看同样被推时，机器人成功站稳了几次。'
        : '当前评测还无法判断策略是否改善。';
  return (
    (result.trainingBudget === 8192 ? '8,192 步快检已完成。' : '训练与评测流程已完成。') +
    quality +
    '\n' +
    (result.links?.experiment
      ? '[查看曲线、对比与回放](' + result.links.experiment + ')'
      : '下一步在工作台查看本次对比与回放。')
  );
}

function sameOriginDanceVideoUrl(baseUrl, candidate, runId) {
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  try {
    const base = new URL(baseUrl);
    const video = new URL(candidate, base.href.replace(/\/+$/, '') + '/');
    const expectedSuffix = `/api/v1/duck/runs/${encodeURIComponent(runId)}/dance-video`;
    if (
      !['http:', 'https:'].includes(video.protocol) ||
      video.origin !== base.origin ||
      video.username ||
      video.password ||
      video.search ||
      video.hash ||
      !video.pathname.endsWith(expectedSuffix)
    )
      return null;
    return video;
  } catch {
    return null;
  }
}

export function runVisualizationLink(baseUrl, runId, danceVideoUrl) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId)) return null;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return null;
  base.pathname = base.pathname.replace(/\/+$/, '') + '/run-detail.html';
  base.searchParams.set('runId', runId);
  const video = sameOriginDanceVideoUrl(baseUrl, danceVideoUrl, runId);
  if (video) base.searchParams.set('videoUrl', video.href);
  return base.toString();
}

function runChoice(candidates, baseUrl) {
  const statusLabels = {
    queued: '排队中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    blocked: '已阻断',
    cancelled: '已取消',
  };
  const choices = (candidates ?? []).flatMap((run) => {
    const url = runVisualizationLink(baseUrl, run?.id);
    if (!url) return [];
    const label =
      String(run.label ?? run.taskId ?? '运行记录')
        .replace(/[\[\]\\*_`<>\r\n]/g, ' ')
        .slice(0, 80)
        .trim() || '运行记录';
    const date =
      typeof run.createdAt === 'string' && Number.isFinite(Date.parse(run.createdAt))
        ? new Date(run.createdAt).toISOString()
        : null;
    const status = Object.hasOwn(statusLabels, run.status)
      ? statusLabels[run.status]
      : '状态待核对';
    return [{ runId: run.id, label, status, createdAt: date, url }];
  });
  const choicesText = choices
    .map(
      ({ label, status, createdAt, url }, index) =>
        `${index + 1}. [${label}](${url}) · ${status}${createdAt ? ' · ' + createdAt : ''}`,
    )
    .join('\n');
  return {
    stage: 'choose-run',
    choices,
    trainingSubmitted: false,
    studentReply: choicesText
      ? `最近的运行记录如下。要接着看哪一轮？\n${choicesText}`
      : candidates
        ? '当前查询没有找到匹配的近期运行。可以粘贴原运行链接或告诉我实验标识。'
        : '请打开原运行链接，或告诉我具体是哪一轮，我会从那条 Run 继续。',
  };
}

function runFailureDetail(payload) {
  const detail = payload?.run?.failureDetail ?? payload?.failureDetail;
  if (!detail || typeof detail !== 'object') return null;
  const parts = [];
  if (detail.errorCode) parts.push(String(detail.errorCode).slice(0, 80));
  if (Number.isSafeInteger(detail.exitCode)) parts.push(`exit ${detail.exitCode}`);
  const tail = typeof detail.stderrTail === 'string' ? detail.stderrTail.trim() : '';
  const cause = tail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' | ')
    .slice(0, 220);
  return parts.length || cause ? { code: parts.join(' '), cause } : null;
}

function nominalDanceEvidence(training, dance) {
  const config = training?.originmanDance;
  if (!Number.isFinite(config?.bpm) || !Array.isArray(config.sections) || !config.sections.length)
    return null;
  const sections = Array.isArray(dance.evaluations)
    ? dance.evaluations.find((row) => row?.bpm === config.bpm)?.sections
    : null;
  if (
    !Array.isArray(sections) ||
    sections.length !== config.sections.length ||
    !sections.every(
      (section, index) =>
        typeof section?.passed === 'boolean' && section.type === config.sections[index]?.type,
    )
  )
    return null;
  return {
    bpm: config.bpm,
    total: sections.length,
    passed: sections.filter((section) => section.passed).length,
    missed: sections.flatMap((section, index) =>
      section.passed
        ? []
        : [
            {
              section: index + 1,
              movement: sectionTitles[section.type] ?? '舞段',
              reason:
                section.clean === false
                  ? '动作稳定性检查未通过'
                  : section.stylePassed === false
                    ? '动作风格检查未通过'
                    : '该段未通过',
            },
          ],
    ),
  };
}

function attachRunVisualization(payload, runId, baseUrl, section) {
  const detail = runVisualizationLink(baseUrl, runId, payload.links?.danceVideo);
  if (!detail) return payload;
  const rawStatus = payload.run?.status ?? payload.status ?? payload.submission?.status;
  const danceRun =
    payload.run?.taskId === 'originman-dance' ||
    payload.run?.training?.engine === 'originman-dance-ppo' ||
    payload.training?.engine === 'originman-dance-ppo' ||
    Boolean(
      payload.run?.training?.originmanDance || payload.training?.originmanDance || payload.dance,
    );
  const isActive = ['queued', 'running', 'cancelling'].includes(rawStatus);
  const progress = danceRun && isActive ? new URL(baseUrl) : null;
  if (progress) {
    progress.pathname = progress.pathname.replace(/\/+$/, '') + '/';
    progress.searchParams.set('robot', 'originman');
    progress.searchParams.set('trainingRun', runId);
    progress.hash = 'train/submit';
  }
  const url = progress?.href ?? detail;
  const status =
    {
      queued: '排队中',
      running: '训练中',
      completed: '已完成',
      failed: '失败',
      blocked: '已阻断',
      cancelled: '已取消',
    }[rawStatus] ?? '已提交';
  const failureDetail = status === '失败' ? runFailureDetail(payload) : null;
  const metrics = payload.run?.metrics ?? payload.metrics;
  const dance = metrics?.originmanDance;
  let learningEvidence;
  let nextStep;
  let studentReply = payload.studentReply || `本轮训练${status}。`;
  const device = metrics?.trainingDevice;
  if (typeof device === 'string' && /^(cpu|mps|cuda(:[0-9]{1,3})?)$/.test(device)) {
    const deviceName = metrics.trainingDeviceName;
    const validName =
      typeof deviceName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._()+-]{0,95}$/.test(deviceName);
    const deviceLabel = validName && deviceName !== device ? `${deviceName} (${device})` : device;
    studentReply += `实际训练设备：${deviceLabel}。`;
  }
  if (rawStatus === 'completed' && dance) {
    const passed = dance.qualityGatePassed;
    studentReply +=
      passed === true
        ? '本轮仿真风格达标。'
        : passed === false
          ? '本轮仿真风格未达标。'
          : '本轮风格质量待核对。';
    learningEvidence = nominalDanceEvidence(payload.run?.training ?? payload.training, dance);
    if (learningEvidence) {
      const { bpm, passed: passedSections, total, missed } = learningEvidence;
      studentReply += `标称 ${bpm} BPM 下，${passedSections}/${total} 段达标。`;
      if (missed.length) {
        studentReply += missed
          .slice(0, 2)
          .map(({ section, movement, reason }) => `第 ${section} 段（${movement}）${reason}。`)
          .join('');
        nextStep = '先看原运行的分段指标和对应舞段，再选择一个变量做对照实验。';
      } else if (passed === false) {
        nextStep = '标称节拍各段均通过。先查看详情中的其他评测节拍和整体检查项。';
      }
    } else if (passed !== true) {
      nextStep = '当前回执未能核对具体舞段。先在原运行详情查看分段结果。';
    }
    if (payload.links?.danceVideo) studentReply += '打开本轮详情即可查看仿真回放。';
    else if ((payload.run?.training ?? payload.training)?.video === false)
      studentReply += '本轮提交时关闭了视频生成，可以查看曲线和分段结果。';
    else if (dance.video?.file === 'dance-replay.mp4')
      studentReply +=
        '平台有本轮视频记录，当前未能核验播放入口。可以在本轮详情查看曲线和分段结果。';
    else studentReply += '本轮暂无可播放的视频，可以先看曲线和分段结果。';
  }
  if (failureDetail)
    studentReply += `\n失败原因${failureDetail.code ? `（${failureDetail.code}）` : ''}：${failureDetail.cause}`;
  if (['failed', 'blocked'].includes(rawStatus))
    nextStep = '先查看原运行的日志和资源状态，确认失败阶段后再决定如何继续。';
  const recommendation = danceCoaching(payload.run ?? payload, runId, section);
  const sectionUrl = recommendation?.section ? new URL(url) : null;
  if (sectionUrl) sectionUrl.hash = `dance-section-${recommendation.section}`;
  if (nextStep && !recommendation) studentReply += nextStep;
  if (recommendation) {
    studentReply += `\n\n${recommendation.text}`;
    if (sectionUrl) studentReply += `\n[查看第 ${recommendation.section} 段](${sectionUrl.href})`;
  }
  if (payload.runDelivery) {
    const { deployment, replay, policy } = payload.runDelivery;
    const deploymentText = {
      eligible: '制品具备部署资格，发布前仍需通过目标设备预检和平台门禁。',
      ineligible: '当前制品不可部署到真机。',
      unverified: '尚未确认制品的部署资格。',
    };
    const replayText = {
      simulation: `[打开本轮仿真回放](${payload.links?.replay})`,
      telemetry: `[查看本轮遥测回放数据](${payload.links?.replay})`,
      unavailable: '当前没有已核验的回放入口。',
    };
    studentReply +=
      '\n' +
      deploymentText[deployment] +
      '\n' +
      replayText[replay] +
      '\n' +
      (policy === 'available'
        ? `[下载本轮策略（ONNX）](${payload.links?.policyDownload})`
        : '当前没有已核验的 ONNX 策略下载入口。');
    const retentionState = (payload.run?.artifactRetention ?? payload.artifactRetention)?.state;
    const retentionText = {
      retained: '平台已留存 ONNX 副本。',
      'not-retained': '平台尚未留存 ONNX 副本。',
      unavailable: '平台暂未确认 ONNX 留存状态。',
    };
    if (Object.hasOwn(retentionText, retentionState))
      studentReply += '\n' + retentionText[retentionState];
  }
  const { failureDetail: _stale, ...rest } = payload;
  return {
    ...rest,
    ...(learningEvidence && { learningEvidence }),
    ...(!recommendation && nextStep && { nextStep }),
    ...(failureDetail ? { failureDetail } : {}),
    ...(recommendation && {
      recommendation: { ...recommendation, ...(sectionUrl && { sectionUrl: sectionUrl.href }) },
      nextStep: recommendation.text,
    }),
    links: { ...payload.links, runDetail: detail, workbench: url },
    visualization: { runId, url, exactRunSelected: true },
    studioNavigation: { tool: 'studio_open_url', arguments: { url } },
    qoderNavigation: {
      surface: 'Qoder 内置浏览器',
      steps: [
        { tool: 'navigate_page', arguments: { url } },
        { tool: 'list_pages', arguments: {} },
        {
          tool: 'select_page',
          argumentsFrom: '按完整URL匹配刚打开的页面，使用实际pageId并传bringToFront:true。',
        },
      ],
    },
    studentReply: `${studentReply}\n[在机器人学习平台查看本轮运行](${url})`,
    delivery:
      'Studio 可用 studio_open_url 时按 studioNavigation 打开右侧工作台；Qoder 按 qoderNavigation 打开并置前。工具不可用时展示可点击链接。打开页面后仍按实际观察区分页面打开、媒体可用和视频已经播放。' +
      (danceRun
        ? '舞蹈独立评测和回放沿本次原 Run 读取。打开 links.runDetail 里的「下载策略文件（ONNX）」供学员下载。不要调用 rdk_experiment_remember 关联舞蹈评测。'
        : '') +
      (recommendation?.previewArguments
        ? '说明指标和对照目标。用户要求采用建议时，用 recommendation.previewArguments 调用 rdk_learning_guide 预览；等用户明确确认当前预览并要求开始后才进入提交。'
        : ''),
  };
}

/** Text-only hosts need actionable references, while rich clients retain full structured data. */
export function experimentModelResult(payload) {
  const run = (value) => (value ? { runId: value.runId, status: value.status } : null);
  const failed = [payload.training, payload.evaluation].find(
    (record) => record?.runId && ['failed', 'blocked'].includes(record.status),
  );
  return {
    contextId: payload.contextId,
    trainingBudget: payload.trainingBudget ?? null,
    studentReply: payload.studentReply,
    training: run(payload.training),
    evaluation: run(payload.evaluation),
    association: {
      executionVerified: payload.association?.executionVerified === true,
    },
    quality: {
      clearGain: payload.quality?.clearGain ?? null,
      hardwareVerified: false,
    },
    playback: { state: payload.playback?.state, verifiedInPlayer: false },
    playbackPlan: payload.playbackPlan,
    detailRead: payload.detailRead,
    studioNavigation: payload.studioNavigation,
    qoderNavigation: payload.qoderNavigation,
    delivery: payload.delivery,
    links: payload.links,
    persistence: payload.persistence,
    view: payload.view,
    nextAction: payload.nextAction,
    ...(failed && {
      recommendedRead: {
        tool: 'rdk_run_logs',
        arguments: { runId: failed.runId },
      },
    }),
    ...(payload.stopWorkflow ? { stopWorkflow: true, retryAllowed: false } : {}),
    pluginRuntime: payload.pluginRuntime,
  };
}

// Capture at import time so an old cached process cannot claim newly replaced files.
const loadedSources = Object.fromEntries(
  [
    'mcp-app-resource.mjs',
    'guided-input.mjs',
    'classroom-guide.mjs',
    'robot-onboarding.mjs',
    'experience-mcp.mjs',
    'experience.mjs',
    'workflow-inspection.mjs',
    'workspace-evidence.mjs',
    'experiment-context.mjs',
    'short-training.mjs',
    'plugin-auth.mjs',
    'authenticated-core.mjs',
    'plugin-errors.mjs',
    'course-setup.mjs',
    'submission-journal.mjs',
    'workshop-course.mjs',
    'originman-dance-config.mjs',
    'dance-coaching.mjs',
    'dance-training.mjs',
    'dance-evaluation.mjs',
    'dance-iteration.mjs',
    'workshop-entry.mjs',
    'development-targets.mjs',
    'playback-plan.mjs',
  ].map((name) => [
    'scripts/' + name,
    createHash('sha256')
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest('hex'),
  ]),
);
if (UI_HTML)
  loadedSources['ui/experiment.html'] = createHash('sha256').update(UI_HTML).digest('hex');
export function pluginRuntimeIdentity() {
  try {
    const declared = JSON.parse(
      readFileSync(new URL('../provenance.json', import.meta.url), 'utf8'),
    );
    if (
      !/^\d+\.\d+\.\d+$/.test(declared.version ?? '') ||
      Object.entries(loadedSources).some(([name, hash]) => declared.wrapperSources?.[name] !== hash)
    )
      return {
        version: null,
        loadedSourcesMatch: false,
        reason: '当前进程与分发来源记录不一致，需刷新连接。',
      };
    return {
      version: declared.version,
      loadedSourcesMatch: true,
      source: 'local-distribution-provenance',
      note: '仅核对本进程加载的编排模块与本地分发记录；不是服务端版本或签名认证。',
    };
  } catch {
    return {
      version: null,
      loadedSourcesMatch: false,
      reason: '当前入口未提供可核对的便携分发记录。',
    };
  }
}

const DANCE_REPLAY_READ_TOOL = {
  name: 'rdk_originman_dance_replay_read',
  description:
    '只读核对当前账号最新的 OriginMan 舞蹈训练及已有仿真回放，也可指定原 Run。返回原详情页入口。',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export const EXPERIENCE_TOOLS = [
  {
    name: 'rdk_plugin_status',
    description: '离线核对当前实际运行插件版本和加载源码是否匹配；无需平台登录，不查询设备。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  COURSE_BRIEF_TOOL,
  TRAINING_CHOICE_TOOL,
  LEARNING_GUIDE_TOOL,
  ORIGINMAN_DANCE_DRAFT_TOOL,
  DANCE_ITERATION_TOOL,
  ...DANCE_TRAINING_TOOLS,
  ...DANCE_EVALUATION_TOOLS,
  DANCE_ACCEPTANCE_TOOL,
  DANCE_REPLAY_READ_TOOL,
  ...WORKSHOP_TOOLS,
  DEVELOPMENT_TARGET_TOOL,
  ...CLASSROOM_TOOLS,
  ...ROBOT_ONBOARDING_TOOLS,
  ...AUTH_TOOLS,
  ...SHORT_TRAINING_TOOLS,
  {
    name: 'rdk_training_wait',
    description:
      '查询指定训练 Run 的状态、ONNX 策略留存/保留/归档、模型制品下载链接、已有仿真回放。这是查看或下载已有结果的首选只读工具。必传原 runId。仍在运行时最多等 20 秒，沿 nextPollArguments 续查。此工具不启动训练或评测。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1 },
        pollCursor: {
          type: 'string',
          pattern: '^[a-f0-9-]{36}$',
          description: '只传上一条等待回执的nextPollArguments中的游标，接续同一Run。',
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ...EXPERIMENT_TOOLS,
  ...WORKFLOW_TOOLS,
  WORKSPACE_EVIDENCE_TOOL,
  {
    name: 'rdk_experience_guide',
    description:
      '高级手动编排或维护者查询完整课程配方时读取本指南；默认学员开始/继续/看效果直接rdk_workshop，不先读本指南：返回仅仿真课程范围、学员步骤、短训目的与下一步规则，另含宿主计算接口配置状态；不返回凭据，不依赖宿主 load_skill。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'rdk_experience_prepare',
    description:
      '用当前同一账号检查场景、指定策略并准备入口。不会打开页面、驱动设备或提交训练；恢复仅返回指引。默认 OriginMan 受扰恢复，MicroDuck 可通过配置继续选择。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'prepare', 'recover'] },
        profile: { type: 'object' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

export function withDancePreview(payload, audience) {
  const run = payload?.run ?? payload;
  const runId = run?.id ?? run?.runId ?? payload?.runId;
  const video = run?.metrics?.originmanDance?.video;
  const { danceVideo: _unverifiedDanceVideo, ...otherLinks } = payload?.links ?? {};
  const withoutUnverifiedDanceVideo = payload?.links
    ? { ...payload, links: otherLinks }
    : { ...payload };
  if (
    run?.status !== 'completed' ||
    run.mock !== false ||
    typeof runId !== 'string' ||
    !video ||
    video.file !== 'dance-replay.mp4' ||
    !/^[a-f0-9]{64}$/.test(video.sha256 || '') ||
    !/^[a-f0-9]{64}$/.test(video.policySha256 || '') ||
    !/^[a-f0-9]{64}$/.test(video.sourceReplaySha256 || '') ||
    video.policySha256 !== run.artifact?.sha256 ||
    video.sourceReplaySha256 !== run.metrics.originmanDance.replay?.sha256
  )
    return withoutUnverifiedDanceVideo;
  const candidate = payload.links?.danceVideo ?? run.links?.danceVideo ?? video.url;
  const verifiedUrl = sameOriginDanceVideoUrl(audience, candidate, runId);
  if (!verifiedUrl) return withoutUnverifiedDanceVideo;
  return {
    ...withoutUnverifiedDanceVideo,
    links: { ...otherLinks, danceVideo: verifiedUrl.href },
    replayKind: 'simulation',
  };
}

export function experienceProxy(
  upstream,
  {
    env = process.env,
    authentication,
    contextDirectory,
    waitBudgetMs = 20000,
    uiHtml = UI_HTML,
  } = {},
) {
  let workflow = null;
  let danceFlow = null;
  const confirmedDancePlans = new Map();
  const baseUrl = authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL;
  const verifiedPreview = async (payload, runId, signal) => {
    const value = withDancePreview(payload, baseUrl);
    if (value.links?.danceVideo || !upstream.verifyLegacyDanceVideo) return value;
    const candidate = './api/v1/duck/runs/' + encodeURIComponent(runId) + '/dance-video';
    const expected = withDancePreview(
      { ...payload, links: { ...payload.links, danceVideo: candidate } },
      baseUrl,
    );
    if (!expected.links?.danceVideo) return value;
    const receipt = (payload.run ?? payload).metrics.originmanDance.video;
    const verified = await upstream.verifyLegacyDanceVideo(runId, receipt, {
      signal,
    });
    return verified === candidate ? expected : value;
  };
  const runResults = async (payload, runId, signal) => {
    if ((payload.run?.status ?? payload.status) !== 'completed')
      return verifiedPreview(payload, runId, signal);
    const detail = runVisualizationLink(baseUrl, runId);
    if (!detail || (payload.run?.id ?? payload.run?.runId ?? payload.runId) !== runId)
      return payload;
    const optional = async (read) => {
      try {
        return await read();
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    };
    if (!payload.run?.artifact?.sha256 && upstream.readTrainingRun) {
      const exact = await optional(() => upstream.readTrainingRun(runId, { signal }));
      if (exact?.id === runId && exact.status === 'completed') payload = { ...payload, run: exact };
    }
    const run = payload.run ?? payload;
    const artifact = run.artifact;
    const route = '/runs/' + encodeURIComponent(runId);
    const policyUrl =
      run.mock === false &&
      artifact?.format === 'onnx' &&
      /^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')
        ? workspaceLink(baseUrl, route + '/artifact')
        : null;
    const [value, policyVerified] = await Promise.all([
      verifiedPreview(payload, runId, signal),
      policyUrl && upstream.verifyPolicyDownload
        ? optional(() => upstream.verifyPolicyDownload(runId, artifact.sha256, { signal }))
        : null,
    ]);
    const links = { ...value.links };
    delete links.replay;
    delete links.policyDownload;
    let replay = 'unavailable';
    if (links.danceVideo) {
      const playback = new URL(runVisualizationLink(baseUrl, runId, links.danceVideo));
      playback.hash = 'replay-heading';
      links.replay = playback.href;
      replay = 'simulation';
    } else if (upstream.readTelemetrySummary && run.mock !== true) {
      const summary = await optional(() =>
        upstream.readTelemetrySummary(
          'rdk_runs_replay',
          { runId },
          {
            signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
          },
        ),
      );
      if (summary?.runId === runId && summary.frameCount > 0) {
        links.replay = workspaceLink(baseUrl, route + '/replay');
        replay = 'telemetry';
      }
    }
    if (policyVerified === true) links.policyDownload = policyUrl;
    return {
      ...value,
      links,
      runDelivery: {
        deployment:
          run.mock === true || artifact?.deployable === false
            ? 'ineligible'
            : artifact?.deployable === true
              ? 'eligible'
              : 'unverified',
        replay,
        policy: policyVerified === true ? 'available' : 'unavailable',
      },
    };
  };
  const readRun = async (runId, signal) => {
    const value = readToolResult(
      await upstream.request(
        'tools/call',
        {
          name: 'rdk_training_status',
          arguments: { runId },
        },
        { signal },
      ),
    );
    if ((value.run?.id ?? value.run?.runId ?? value.runId) !== runId)
      throw Error('平台未确认这条 Run。请重新打开原运行链接确认账号与记录。');
    return value;
  };
  const readDanceReplay = async (args, signal) => {
    if (
      Object.keys(args).some((key) => key !== 'runId') ||
      (args.runId !== undefined &&
        (typeof args.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(args.runId)))
    )
      throw Error('请提供有效的原 Run ID，或留空以查询最新舞蹈训练。');

    let runId = args.runId;
    if (!runId) {
      const candidates = await upstream.readLearningRuns({ danceOnly: true, signal });
      const latest = candidates
        .filter(
          (run) => run.taskId === 'originman-dance' && Number.isFinite(Date.parse(run.createdAt)),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (!latest)
        return {
          ok: true,
          found: false,
          studentReply: '当前账号暂无可定位的 OriginMan 舞蹈训练。',
        };
      runId = latest.id;
    }
    const run = await upstream.readTrainingRun(runId, { signal });
    if (run.id !== runId || run.taskId !== 'originman-dance')
      throw Error('平台未确认这是一条当前账号可见的 OriginMan 舞蹈 Run。');

    const preview = await verifiedPreview({ run }, runId, signal);
    const videoUrl = preview.links?.danceVideo ?? null;
    const replay = run.metrics?.originmanDance?.replay;
    const trajectorySha256 = /^[a-f0-9]{64}$/.test(replay?.sha256 ?? '') ? replay.sha256 : null;
    let trajectoryVerification = null;
    if (trajectorySha256 && upstream.readDanceTrajectoryVerification) {
      try {
        trajectoryVerification = await upstream.readDanceTrajectoryVerification(
          runId,
          trajectorySha256,
          { signal },
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (error.needsLogin) throw error;
      }
    }
    const url = runVisualizationLink(baseUrl, runId);
    return {
      ok: true,
      found: true,
      run: {
        id: runId,
        taskId: run.taskId,
        createdAt: run.createdAt,
        status: run.status,
        label: run.label,
      },
      replay: {
        videoUrl,
        trajectorySha256,
        frameContinuity: trajectoryVerification ? 'verified' : 'unverified',
        ...(trajectoryVerification ? { trajectoryVerification } : {}),
      },
      ...(url && {
        links: { runDetail: url },
        studioNavigation: { tool: 'studio_open_url', arguments: { url } },
      }),
    };
  };
  let uiEnabled = false,
    upstreamResources = false;
  let host = {
    family: 'unknown',
    reportedVersion: null,
    source: 'initialize-client-info',
    verified: false,
  };
  const pollCursors = new Map();
  const waitForRun = async (args, signal, tool = 'rdk_training_wait', budget = waitBudgetMs) => {
    if (
      typeof args.runId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(args.runId) ||
      Object.keys(args).some((key) => !['runId', 'pollCursor'].includes(key)) ||
      (args.pollCursor !== undefined && !/^[a-f0-9-]{36}$/.test(args.pollCursor))
    )
      throw Error('请使用原 Run 及上一条回执提供的续查参数。');
    const key = tool + ':' + args.runId;
    if (args.pollCursor && pollCursors.get(key) !== args.pollCursor)
      throw Object.assign(
        Error('续查游标不属于当前 Run 或已更新；重连后可省略游标重新查询同一 Run。'),
        { platformCode: 'WAIT_CURSOR_MISMATCH' },
      );
    const deadline = Date.now() + Math.max(1, Math.min(20000, budget));
    for (;;) {
      signal?.throwIfAborted();
      const value = await readRun(args.runId, signal);
      if (!['queued', 'running', 'pending'].includes(value.run?.status ?? value.status)) {
        pollCursors.delete(key);
        return value;
      }
      if (Date.now() >= deadline) {
        const cursor = randomUUID();
        pollCursors.set(key, cursor);
        if (pollCursors.size > 32) pollCursors.delete(pollCursors.keys().next().value);
        return {
          ...value,
          waiting: true,
          observedAt: new Date().toISOString(),
          nextPollArguments: { runId: args.runId, pollCursor: cursor },
          nextAction: '同一 Run 仍在运行。使用 nextPollArguments 接续查询。',
        };
      }
      await new Promise((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        };
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason ?? Error('Aborted'));
        };
        const timer = setTimeout(done, Math.min(4000, deadline - Date.now()));
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  };
  const evaluationReader = createDanceEvaluationReader(upstream);
  const completeDanceAcceptance = async (args, signal, budget) => {
    const value = observe(
      await waitForRun(args, signal, DANCE_ACCEPTANCE_TOOL.name, budget),
      args.runId,
    );
    const task = value.run?.taskId ?? value.taskId;
    if (task && task !== 'originman-dance') throw Error('请选择一条 OriginMan 舞蹈 Run。');
    const detail = runVisualizationLink(baseUrl, args.runId);
    const status = value.run?.status ?? value.status;
    if (status !== 'completed') {
      const result = attachRunVisualization(value, args.runId, baseUrl);
      return {
        ...result,
        simulationAcceptance: { state: value.waiting ? 'waiting' : 'not-evaluated' },
        ...(value.waiting && {
          nextTool: DANCE_ACCEPTANCE_TOOL.name,
          nextArguments: value.nextPollArguments,
          delivery:
            '按 studioNavigation 显示本轮进度，继续调用 nextTool 和 nextArguments，完成后自动评测。',
        }),
      };
    }
    try {
      const run = await upstream.readTrainingRun?.(args.runId, { signal });
      if (run?.id !== args.runId) throw Error('当前连接未确认这条原 Run。');
      const simulationAcceptance = await acceptDanceSimulation(run, {
        upstream: upstream.evaluateDanceRun ? { evaluateDanceRun: evaluationReader } : upstream,
        signal,
      });
      const result = attachRunVisualization(
        await runResults({ run }, args.runId, signal),
        args.runId,
        baseUrl,
      );
      return {
        ...result,
        simulationAcceptance,
        delivery:
          '立即按 studioNavigation 打开 Studio 右侧的本轮结果。页面有判定、分段检查、回放和策略下载。报告实际可用的入口。',
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'DANCE_EVALUATION_PENDING')
        return {
          runId: args.runId,
          status,
          simulationAcceptance: { state: 'waiting', reason: error.message },
          nextTool: DANCE_ACCEPTANCE_TOOL.name,
          nextArguments: { runId: args.runId },
          studentReply: error.message,
          delivery: '仅续查原 Run 的评测。不要改提训练。',
        };
      return {
        runId: args.runId,
        status,
        simulationAcceptance: { state: 'unverified', reason: error.message },
        ...(detail && { links: { runDetail: detail } }),
        studentReply: '本轮训练已完成，独立仿真验收待核对。' + error.message,
        delivery: '展示待核对原因。恢复时对同一个 Run 再验收。',
      };
    }
  };
  const stoppedResult = () => {
    const value = {
      ok: false,
      stopWorkflow: true,
      retryAllowed: false,
      error: {
        platformCode: 'WORKSHOP_FLOW_STOPPED',
        message: '本次短训流程已受阻或已绑定原Run，不接受换标识、换资源或改用通用提交工具重交。',
        nextAction:
          '保留原Run，只读查看状态和原因。新实验须由用户明确开始新任务；当前任务立即结束。',
      },
    };
    return {
      isError: true,
      structuredContent: value,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    };
  };
  const observe = (value, runId) => {
    if (!workflow) return value;
    const status = value?.status ?? value?.run?.status;
    if (
      ['failed', 'blocked', 'cancelled', 'canceled'].includes(status) &&
      [workflow.runId, workflow.evaluationRunId].includes(runId)
    ) {
      workflow.stopped = true;
      return {
        ...value,
        stopWorkflow: true,
        retryAllowed: false,
        nextAction: '本次运行已失败；停止训练流程，保留原Run和原因，不换机器、参数或实验标识重交。',
      };
    }
    if (
      (runId === workflow.evaluationRunId ||
        (workflow.phase === 'dance' && runId === workflow.runId)) &&
      status === 'completed'
    )
      workflow.completed = true;
    return value;
  };
  const reservedNames = new Set(EXPERIENCE_TOOLS.map((tool) => tool.name));
  const validateCatalogPage = (page) => {
    if (
      !Array.isArray(page?.tools) ||
      page.tools.some((tool) => typeof tool?.name !== 'string' || !tool.name.trim()) ||
      (page.nextCursor !== undefined &&
        (typeof page.nextCursor !== 'string' || !page.nextCursor.length))
    )
      throw new Error('Invalid upstream tool catalog or paging cursor.');
    const names = page.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length)
      throw new Error('Duplicate names in upstream tool catalog.');
    if (names.some((name) => reservedNames.has(name) && name !== LEARNING_GUIDE_TOOL.name))
      throw new Error('Upstream tool name collides with a reserved experience extension tool.');
    // The bundled core also has a guide. The host always receives the richer
    // wrapper contract, matching the handler that dispatches this tool.
    return {
      ...page,
      tools: page.tools.filter((tool) => tool.name !== LEARNING_GUIDE_TOOL.name),
    };
  };
  const readCatalog = async (signal) => {
    const tools = [];
    const names = new Set();
    const cursors = new Set();
    let params = {};
    for (let pageNumber = 0; pageNumber < 128; pageNumber++) {
      signal?.throwIfAborted();
      const page = validateCatalogPage(await upstream.request('tools/list', params, { signal }));
      signal?.throwIfAborted();
      for (const tool of page.tools) {
        if (names.has(tool.name)) throw new Error('Duplicate names across catalog pages.');
        names.add(tool.name);
        tools.push(tool);
      }
      if (tools.length > 10000) throw new Error('Upstream tool catalog exceeds safety budget.');
      if (page.nextCursor === undefined) return { tools };
      if (cursors.has(page.nextCursor)) throw new Error('Repeated upstream paging cursor.');
      cursors.add(page.nextCursor);
      params = { cursor: page.nextCursor };
    }
    throw new Error('Upstream tool catalog exceeds paging budget.');
  };
  const submitDance = async (args, signal, acceptWorker) => {
    const catalog = await readCatalog(signal);
    const call = async (name, args) =>
      readToolResult(await upstream.request('tools/call', { name, arguments: args }, { signal }));
    return trainOriginmanDance(args, call, {
      directory: contextDirectory,
      defaultResourceId: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID,
      readModels: upstream.readModels && (() => upstream.readModels({ signal })),
      toolNames: catalog.tools.map((tool) => tool.name),
      acceptWorker,
    });
  };
  const danceAccount = async () => {
    const status = await authentication?.status();
    return status?.authenticated === true ? status.accountId : null;
  };
  const stepDance = createDanceIteration({
    baseUrl,
    contextDirectory,
    account: danceAccount,
    accept: (runId, signal) =>
      completeDanceAcceptance({ runId }, signal, Math.min(waitBudgetMs, 4000)),
    recover: (contextId) => recoverDanceSubmission(contextId, contextDirectory),
    submit: (args, signal) => submitDance(args, signal, matchesDanceIterationGpu),
  });
  const iterateDance = createDanceGoalContinuation({
    baseUrl,
    account: danceAccount,
    contextDirectory,
    iterate: stepDance,
  });
  const automaticDanceInput = async (input, signal) => {
    if (input.resumeContextId || input.goal === 'original-quality-gate') return input;
    if (!input.dance || !Number.isSafeInteger(input.totalSteps)) return input;
    const dance = { schemaVersion: 1, title: 'OriginMan 舞蹈目标', ...input.dance };
    if (dance.trainingSteps === input.totalSteps) delete dance.trainingSteps;
    let computeResourceId = input.computeResourceId ?? env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID;
    if (!computeResourceId) {
      const reply = await upstream.request(
        'tools/call',
        { name: 'rdk_compute_resources_list', arguments: {} },
        { signal },
      );
      const resources = readToolResult(reply).computeResources ?? [];
      const matching = resources.filter(
        (resource) =>
          resource.mock === false &&
          resource.status === 'online' &&
          resource.engines?.includes('originman-dance-ppo') &&
          matchesDanceIterationGpu(resource),
      );
      if (matching.length !== 1)
        throw Error('请选择一台已连接且支持 OriginMan 舞蹈的 RTX 4090 Worker。');
      computeResourceId = matching[0].id;
    }
    const contextId =
      input.contextId ??
      (danceFlow?.input &&
      isDeepStrictEqual(danceFlow.input.dance, dance) &&
      danceFlow.input.totalSteps === input.totalSteps
        ? danceFlow.input.contextId
        : 'om-' + randomUUID().replaceAll('-', '').slice(0, 20));
    return {
      ...input,
      goal: input.goal ?? 'dance-quality-gate',
      contextId,
      computeResourceId,
      dance,
    };
  };
  const backgroundDanceResult = (goal) => {
    const url = new URL('./dance-iterations.html', baseUrl.replace(/\/+$/, '') + '/');
    url.searchParams.set('goal', goal.id);
    return {
      background: true,
      iteration: goal,
      ...(goal.state !== 'waiting' && { stopWorkflow: true }),
      links: { iteration: url.href },
      studioNavigation: { tool: 'studio_open_url', arguments: { url: url.href } },
      studentReply:
        goal.state === 'waiting'
          ? '平台已接管这组仿真实验。右侧会自动更新训练、评测和预算。'
          : goal.reason,
      delivery:
        '立即按 studioNavigation 在 Studio 右侧打开同一实验，并在回复保留此链接。平台独立运行，不需要继续调用训练或轮询工具。关闭 Studio 后，可从同一链接进入继续查看。',
    };
  };
  const danceRouteFeedback = (code, message, continuation) => {
    const value = {
      ok: false,
      error: { platformCode: code, message },
      ...(continuation ?? {
        nextTool: DANCE_ITERATION_TOOL.name,
        nextAction:
          '自动调参用 rdk_originman_dance_iterate。首次只传 totalSteps 和 dance（bpm、sections 每段含 type、beats、intensity）。单轮训练先经 rdk_learning_guide 确认单轮配方。',
      }),
    };
    return {
      isError: true,
      structuredContent: value,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    };
  };
  const clientContext = () => {
    const configured = [
      'RDK_LEARNING_STUDIO_HOST_ORIGIN',
      'RDK_LEARNING_STUDIO_HOST_TOKEN',
      'RDK_STUDIO_PLUGIN_REGISTRY',
      'RDK_STUDIO_PLUGIN_ROOT',
      'RDK_STUDIO_SESSION_FILE',
    ].every((name) => typeof env[name] === 'string' && env[name].trim());
    return {
      observedAt: new Date().toISOString(),
      nativeCompute: {
        configuration: configured ? 'present' : 'missing',
        runtimeVerified: false,
        nextAction: configured
          ? '配置存在；仍需通过原生计算状态工具核对宿主、账号和连接，不据配置宣称已接通。'
          : '仅可选受管计算适配器的配置缺失；未测试本地或远程训练运行时，不能推断任何训练路径不可用。回答不得称本地训练断路或只能远程训练；任务资源与任务依赖需各自实测。',
      },
      browserAuthentication:
        '插件认证与网页认证分别验证；网页显示游客时，通过正常登录流程进入同一账号，不复制会话凭据。',
    };
  };
  const readProfile = () =>
    JSON.parse(
      readFileSync(new URL('../references/experience-profile.json', import.meta.url), 'utf8'),
    );
  return async function dispatch(method, params = {}, signal) {
    if (method === 'initialize') {
      const reported = String(params.clientInfo?.name ?? '').toLowerCase();
      const version = String(params.clientInfo?.version ?? '');
      host = {
        family:
          ['qoder', 'studio', 'codex', 'vscode', 'claude', 'cursor'].find((name) =>
            reported.includes(name),
          ) ?? 'other',
        reportedVersion: /^\d{1,3}(?:\.\d{1,3}){1,3}(?:[-+][A-Za-z0-9.-]{1,30})?$/.test(version)
          ? version
          : null,
        source: 'initialize-client-info',
        verified: false,
      };
      const result = await upstream.request(method, params, { signal });
      const legacyServer = result.serverInfo?.name === 'duck-lab-mcp';
      const runtime = legacyServer ? pluginRuntimeIdentity() : null;
      uiEnabled = Boolean(uiHtml) && uiSupported(params);
      upstreamResources = Boolean(result.capabilities?.resources);
      return {
        ...result,
        ...(legacyServer
          ? {
              serverInfo: {
                ...result.serverInfo,
                name: 'rdk-robot-learning-platform',
                title: 'RDK Robot Learning Platform',
                ...(runtime?.loadedSourcesMatch ? { version: runtime.version } : {}),
              },
            }
          : {}),
        ...(uiEnabled
          ? {
              capabilities: {
                ...result.capabilities,
                resources: result.capabilities?.resources ?? {},
              },
            }
          : {}),
        instructions:
          (result.instructions ?? '').replace(/[（(]Duck Lab[）)]/gi, '') +
          '\n已知 Run ID，用户要查询留存、归档、ONNX/策略下载、制品可用性或已有回放时，第一步只发现并调用 rdk_training_wait，传原 runId，展示 artifactRetention、links.policyDownload 和已核验的 links.replay。Studio 的外部工具每轮按需登记，当前轮先用 load_tools.names 传目录中的 mcp__<连接名>__rdk_training_wait，默认 mcp__rdk-robot-learning-platform__rdk_training_wait；登记后调用该工具。已有结果查询不调用独立评测、验收、训练或渲染工具。\n' +
          '\n连接诊断以当前 RDK Robot Learning Platform 插件的 rdk_platform_status 回执为准。先核对返回的 baseUrl、health.ready、session.authenticated 和 canAccessWorkspace；需要版本时调用 rdk_plugin_status。工具目录和旧技能只说明入口，不能证明平台故障。仅在用户明确选择本机部署时检查本机端口或运行旧 CLI。云端连接下，本机 18102 无监听与平台状态无关。若宿主未暴露这些工具，说明当前对话未加载此连接，指引启用或重连插件；不要用旧技能、旧 MCP 或 shell 探针代替已配置的云端连接。仅咨询插件能力时给可用入口，具体工具数量以当前目录为准。' +
          '\n面向用户统一称为 RDK Robot Learning Platform（RDK 机器人学习平台）。介绍能力时先给课程、训练、评测与回放入口；仅在用户追问时展开底层服务、协议与部署细节。' +
          '\n用户说“带我开启/开始 OriginMan Workshop”时，直接调用 rdk_workshop({intent:"new"})。明确受扰恢复时增加 course:"recovery"。按回执导航，再展示 studentReply。如果只拿到旧课程目录，使用回执的绝对链接。127.0.0.1 可能是 MCP 内部转发地址，诊断网页必须依据插件配置的平台 URL。' +
          '\n用户问插件能做什么时，调用 rdk_platform_status 后直接使用 studentReply；仅在追问时展开工具名、数量、接口地址或设备门槛。' +
          '\n这是通用机器人学习插件。先按用户的机型与目标使用 rdk_learning_guide；打开工作台传 task:overview，强化学习或模仿学习有通用入口，只有明确选择课程时才使用 OriginMan 专用工具。开始新实验传 intent:new；查看结果传 intent:results 和原 Run；改参传 intent:retry、原 Run 与 changes，等确认再使用 nextArguments。Studio 优先用 studio_open_url 打开已验证的工作台链接，仍保留可点击地址。已打开不表示已播放。' +
          '\n最高优先的舞蹈路由：只给舞蹈仿真目标和总预算、要求未达标自动调奖励或预算耗尽停止，第一步直接加载并调用 rdk_originman_dance_iterate。输入示例 {"totalSteps":524288,"dance":{"bpm":130,"sections":[{"type":"weight-shift","beats":4,"intensity":0.9}]}}。插件选择 4090、64 并行、登记原实验。无需查本地台账、询问确认或预先提交。评测慢或调用失败时只重试原 nextArguments，禁止调用 rdk_originman_dance_train、rdk_training_submit 或换 contextId 重交。首次收到后台实验回执立刻按 studioNavigation 打开右侧并保留原链接，页面自动更新；无需继续轮询工具。若曾使用旧版回执，仍按 nextArguments 接续。' +
          '\n版本检查分别报告插件实际加载版本、宿主登记与平台连接；工具不可用、读失败和已确认空列表分别报告。舞蹈仿真通过不具备部署资格。部署预检被拒绝或设备工具缺失时保留阻断，不使用终端、SSH 或设备执行工具替代受控部署。' +
          '\n' +
          '\n提交 OriginMan 舞蹈或收到一键仿真验收请求后，沿原 runId 调用 rdk_originman_dance_acceptance。每次待运行回执继续传 nextArguments，终态自动同源评测；验收出判定后按 studioNavigation 打开 Studio 右侧。比较两条记录用 rdk_originman_dance_compare。' +
          WORKSPACE_EVIDENCE_INSTRUCTIONS +
          '\n用户要上传、下载或管理托管数据集时，调用 rdk_learning_guide({intent:"start",task:"datasets"})，展示证据与记录入口。上传走「上传数据集」，下载走数据集详情中的「下载托管文件」。rdk_dataset_register 只登记元数据。' +
          '\n' +
          STUDIO_WORKSHOP_NAVIGATION +
          ' 已明确选择受扰恢复 Workshop 时用 rdk_workshop 传 course:"recovery"。预算由页面确认。纯咨询用课程说明。' +
          '\n课堂新学员或新机离线准备：rdk_classroom_guide携带已知answers，只展示studentReply，每次一个中文问题，不重复问已知项。要求依据才detail=full。阶段标准读robot_onboarding_guide，证据读robot_acceptance_assess；needs-input不是通过。离线知识不要求平台登录，不因离线准备启动训练。' +
          '\n默认离线可了解课程，不主动授权、测试算力或连接板卡。需要账号才能继续时，提示“连接学习平台”，等用户明确要求连接才调用rdk_auth_login，浏览器确认后用rdk_auth_status。只在宿主已显式配置绑定账号时复用该身份，不索取密码或Cookie。' +
          '\n换学习平台账号用rdk_auth_switch_account。查看开发机先用rdk_development_targets list。用户明确选算力机开始Workshop时，按唯一名称匹配算力机ID，传rdk_workshop intent:new、当前课程和computeResourceId。未指定课程的新 Workshop 默认舞蹈；仅用户明确受扰恢复时传recovery。用户明确要求连接某台板卡时才按板卡列表匹配ID并用connect-board。名称有歧义时让用户选择，不在聊天收集凭据。' +
          '\n任务意图优先：当前对话已明确OriginMan强化学习跳舞时，“带我开始/重新开始Workshop”沿 danceTraining 流程取得新 contextId并继续已确认编舞；不得展示旧实验结果或调用rdk_workshop、rdk_originman_train等受扰恢复链路。舞蹈继续/看看效果只查询原Run。提交、等待和状态查询回执的qoderNavigation/visualization必须打开并聚焦到本轮Run；宿主不支持导航时给可点击链接。' +
          '\n简短咨询预算用途、计数单位或流程/效果/回放完成标准：优先rdk_originman_course_brief，逐字展示studentReply两句即结束，不加载整份指南和历史证据。实际成绩另读原评测；明确问依据才按需读引用。不编造计数倍率。' +
          '\n交互约定：默认简短中文，按“当前进度→本次结果→下一步”回答。认证、版本、契约和资源校验在后台完成，正常时不逐项播报。只在阶段变化、阻断或需要用户选择时更新；不重复播报running，不展示内部推理。UUID、工具名、摘要和错误码仅在用户查看诊断时展开。正常结果优先给曲线、对比图和回放入口；宿主能打开工作台则在工作台展示，否则给可点击链接。没有实际渲染能力不伪装交互卡片，没有播放器观测不称已播放。' +
          '\n高级独立训练才使用预算选择与原子训练工具：按用户已选预算执行，不重复问。已选择恢复课程后用rdk_workshop打开按钮工作台，在页面选择预算并自动接续；只咨询或先不要开始时不提交。高级手动提交仍核对当前账号、完整manifest、同源父Run与权重，失败不改标识重交。' +
          '\n等待：沿用同一Run及nextPollArguments，正常等待窗口结束继续读；不启动shell sleep。失败或stopWorkflow=true停止所有自动提交，不换标识、资源或参数重交；仍可只读查询原Run、日志及恢复已有引用。SUBMISSION_REFERENCE_SAVE_FAILED表示任务已经提交，保留回执并恢复，绝不能说尚未提交。' +
          '\n实验接续：通用流程提交后用明确contextId保存训练及同源评测引用；专用短训工具已保存，无需重复。跨聊天或软件继续时使用明确实验标识调用experiment_resume，并重新验证当前平台和账号；不选择全局最新Run，不扫描其他账号。本机引用不等于跨机器同步。404、网络失败和断线不触发重交。新实验使用新contextId，调参须用户明确提出。' +
          '\n找不到原实验引用时，用rdk_learning_guide的intent:results列出近期记录，展示工具给出的可点击名称、时间和状态，请用户选一次。舞蹈失败先给确切段号和检查项，再给本轮详情链接。用户只改一段时用sectionEdits，按studentReply和unchangedSections回显。用户问算力离线后怎么做时，沿用已有编舞和预算调用rdk_learning_guide，展示返回的算力或执行资源链接；无需重复整理草案。选择算力或改参预览不代表用户已确认提交。' +
          '\n结果：只展示本次Run的真实original/tuned/rl对比；执行完成、质量提升和真机资格分别判断，短训不承诺提升。提交、等待或状态查询新Run后立刻按回执的qoderNavigation在内置浏览器打开并置前，或使用visualization.url；没有导航能力时保留可点击链接。舞蹈训练排队或运行时，跳转到工作台 Run 与进度并选中本次 Run；终态在 run-detail.html 按 Run ID 读取详情，账号无权查看时明确提示，不改看全局最新Run。舞蹈回放须先通过本次策略和轨迹SHA核验，再由页面内播放器播放；不调用真机rdk_replay_video或evaluationId接口；媒体链接不做正文抓取、HEAD、curl或独立浏览器认证探测。没有观测就报告播放待验证。一般流程用workflow_inspect按需看证据，不默认打印整张技术状态表；新训练前training_prepare刷新资源。默认GPU，CPU须明确选择，不自动降级、不操作真机。\n本次原生计算配置：' +
          clientContext().nativeCompute.configuration +
          '。宿主接口缺失时不要要求已经在桌面中的用户重复“去桌面操作”；用指南中的 clientContext 说明实际缺口。' +
          ORIGINMAN_COURSE_INSTRUCTIONS +
          '\n用户明确要求助手自动播放已有结果时，保留0.5.5能力：按experiment_resume.playbackPlan使用内置页面工具，list_pages取实际pageId，select_page({pageId,bringToFront:true})，核对可见性与本次来源后只执行startScript一次，再观察真实时间推进与ended。计划不等于执行；禁止seek、伪造进度、改安全设置或重交任务。默认按钮课程仍由页面推进，不主动调用此高级计划。' +
          '\n受扰恢复用 rdk_workshop 的 continue 或 results 接续原实验。已有 contextId 时，它是实验标识。需要评测明细时，从恢复结果的 detailRead 或 evaluation.runId 读取实际 Run ID。先报告 quality.clearGain，再展示本轮页面。Qoder 按返回的 qoderNavigation 操作。舞蹈继续用原舞蹈 Run。' +
          '\n普通Workshop回执：优先使用工具studentReply，默认入口不播报加载和打开过程，导航后仅一句中文加一个实验页链接。页面已显示曲线和对比时不重复抄技术表；账号、UUID、英文套件名、摘要、video字节和部署细节按用户明确要求再展开。明确要求播放才尝试播放器操作；没有播放观察时说明回放待播放。只报告完成的四个主阶段；单变量调参是可选后续，不算本轮未完成项。',
      };
    }
    if (method === 'resources/read' && params.uri === UI_URI) {
      if (!uiEnabled) throw Error('宿主未协商交互视图；请使用实验页链接。');
      return uiResource(uiHtml);
    }
    if (method === 'resources/list' && uiEnabled) {
      const result = upstreamResources
        ? await upstream.request(method, params, { signal })
        : { resources: [] };
      if (!Array.isArray(result.resources) || result.resources.some((r) => r.uri === UI_URI))
        throw Error('上游资源目录与交互视图发生冲突。');
      return result.nextCursor === undefined
        ? {
            ...result,
            resources: [
              ...result.resources,
              {
                uri: UI_URI,
                name: '本次机器人学习实验',
                mimeType: UI_MIME,
                _meta: uiMetadata,
              },
            ],
          }
        : result;
    }
    if (method === 'tools/list') {
      const result = validateCatalogPage(await upstream.request(method, params, { signal }));
      const forUi = (tool) =>
        uiEnabled && tool.annotations?.readOnlyHint !== true
          ? {
              ...tool,
              _meta: {
                ...tool._meta,
                ui: { ...tool._meta?.ui, visibility: ['model'] },
              },
            }
          : tool;
      // Preserve upstream paging; advertise the extension exactly once, on the final page.
      return result.nextCursor === undefined
        ? {
            ...result,
            tools: [
              ...result.tools
                .map((t) =>
                  t.name === 'rdk_replay_video'
                    ? {
                        ...t,
                        description:
                          '仅用于真机遥测视频渲染；OriginMan短训评测的视频已随评测Run生成，不能用本工具。请rdk_experiment_resume优先获取links.experiment；旧平台使用links.workbench并在页面内选择本次Run、打开播放器。\n' +
                          t.description,
                      }
                    : t.name === 'rdk_workshop_catalog'
                      ? {
                          ...t,
                          description:
                            '查询 OriginMan 课程资料。用户要打开 Workshop 时优先调用 rdk_workshop。\n' +
                            (t.description ?? ''),
                        }
                      : courseToolHint(t.name)
                        ? {
                            ...t,
                            description: courseToolHint(t.name) + (t.description ?? ''),
                          }
                        : t,
                )
                .map(forUi),
              ...EXPERIENCE_TOOLS.map((t) =>
                uiEnabled && UI_TOOLS.has(t.name)
                  ? {
                      ...t,
                      _meta: {
                        ...t._meta,
                        ui: {
                          ...t._meta?.ui,
                          resourceUri: UI_URI,
                          visibility:
                            t.annotations?.readOnlyHint === true ? ['model', 'app'] : ['model'],
                        },
                      },
                    }
                  : t,
              ),
            ],
          }
        : { ...result, tools: result.tools.map(forUi) };
    }
    const input = params.arguments ?? {};
    if (method === 'tools/call') {
      const studio =
        host.family === 'studio' ||
        env.RDK_STUDIO_LOGIN_BOUND === '1' ||
        env.RDK_STUDIO_INHERIT_LOGIN === '1';
      const danceRoute =
        input.taskId === 'originman-dance' ||
        input.engine === 'originman-dance-ppo' ||
        input.originmanDance != null ||
        input.training?.originmanDance != null;
      const directDance =
        params.name === 'rdk_originman_dance_train' ||
        (params.name === 'rdk_training_submit' && (danceRoute || danceFlow)) ||
        (danceFlow && ['rdk_originman_train', 'rdk_originman_short_train'].includes(params.name));
      if (
        (params.name === 'rdk_training_prepare' && danceRoute) ||
        (directDance && (danceFlow || (studio && !confirmedDancePlans.has(input.contextId))))
      ) {
        const result = danceFlow?.result;
        return danceRouteFeedback(
          danceFlow ? 'DANCE_GOAL_RESERVED' : 'DANCE_ROUTE_REQUIRED',
          danceFlow
            ? '本次预算属于原自动迭代实验。普通训练没有提交，请继续查原实验。'
            : '当前调用没有已确认的单轮配方，训练未提交。自动迭代请走自动入口。',
          result?.nextArguments
            ? { nextTool: DANCE_ITERATION_TOOL.name, nextArguments: result.nextArguments }
            : result
              ? { ...result, stopWorkflow: true }
              : null,
        );
      }
    }
    const sameContext =
      workflow && typeof input.contextId === 'string' && input.contextId === workflow.contextId;
    const sameRun =
      workflow &&
      typeof input.runId === 'string' &&
      [workflow.runId, workflow.evaluationRunId].includes(input.runId);
    if (method === 'tools/call' && sameRun && params.name === 'rdk_replay_video') {
      const value = {
        ok: false,
        stopWorkflow: false,
        error: {
          platformCode: 'ORIGINMAN_REPLAY_ROUTE',
          message: 'OriginMan评测视频不使用真机遥测渲染工具。',
          nextAction:
            '调用rdk_experiment_resume，优先打开links.experiment；旧平台打开links.workbench并按selection选择本次Run、打开播放器。不要新建评测或渲染任务。',
        },
      };
      return {
        isError: true,
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      };
    }
    if (
      method === 'tools/call' &&
      workflow &&
      !workflow.completed &&
      ((sameContext &&
        workflow.stopped &&
        SHORT_TRAINING_TOOLS.some((tool) => tool.name === params.name)) ||
        (sameContext && workflow.stopped && params.name === 'rdk_originman_dance_train') ||
        (params.name === 'rdk_training_submit' &&
          (sameContext ||
            (typeof input.experimentId === 'string' && input.experimentId === workflow.contextId) ||
            (typeof input.sourceRunId === 'string' && input.sourceRunId === workflow.runId) ||
            input.idempotencyKey === workflow.contextId + '-train')))
    )
      return stoppedResult();
    if (
      method === 'tools/call' &&
      (EXPERIENCE_TOOLS.some((t) => t.name === params.name) ||
        (params.name === 'rdk_datasets_list' && upstream.readDatasets))
    ) {
      try {
        let payload;
        const operationId = 'om-' + randomUUID().replaceAll('-', '').slice(0, 20);
        if (params.name === DANCE_ACCEPTANCE_TOOL.name) {
          payload = await completeDanceAcceptance(params.arguments ?? {}, signal);
        } else if (params.name === DANCE_REPLAY_READ_TOOL.name) {
          payload = await readDanceReplay(params.arguments ?? {}, signal);
        } else if (params.name === DANCE_ITERATION_TOOL.name) {
          danceFlow ??= {};
          const draft = await automaticDanceInput(input, signal);
          const active = danceFlow.result?.nextArguments;
          if (active && !draft.resumeContextId && draft.contextId !== active.resumeContextId)
            return danceRouteFeedback('DANCE_GOAL_RESERVED', '继续原实验，预算已保存。', {
              nextTool: DANCE_ITERATION_TOOL.name,
              nextArguments: active,
            });
          const previousGoal = danceFlow.result?.background && danceFlow.result.iteration.id;
          if (!draft.resumeContextId && !previousGoal) danceFlow.input = draft;
          const goalId = draft.resumeContextId || previousGoal;
          const goal = goalId
            ? await upstream.readDanceGoal?.(goalId, { signal })
            : draft.goal === 'dance-quality-gate' && upstream.startDanceGoal
              ? await upstream.startDanceGoal(
                  {
                    contextId: draft.contextId,
                    dance: draft.dance,
                    computeResourceId: draft.computeResourceId,
                    ...(draft.modelId && { modelId: draft.modelId }),
                    totalSteps: draft.totalSteps,
                  },
                  { signal },
                )
              : null;
          if (previousGoal && !goal) throw Error('当前连接未找到原后台实验。');
          payload = goal ? backgroundDanceResult(goal) : await iterateDance(draft, signal);
          danceFlow.result = payload;
        } else if (DANCE_EVALUATION_TOOLS.some((tool) => tool.name === params.name)) {
          payload = await danceEvaluation(params.name, params.arguments ?? {}, {
            upstream,
            baseUrl,
            signal,
          });
        } else if (params.name === 'rdk_datasets_list') {
          if (Object.keys(params.arguments ?? {}).length) throw Error('数据集列表查询不需要参数。');
          payload = await upstream.readDatasets({ signal });
        } else if (params.name === WORKSPACE_EVIDENCE_TOOL.name) {
          if (!upstream.inspectWorkspace) throw Error('当前宿主没有工作区证据读取接口。');
          payload = await upstream.inspectWorkspace(params.arguments ?? {}, { signal });
          if (payload.scope === 'datasets' && payload.datasets.studentReply)
            payload.studentReply = payload.datasets.studentReply;
          if (
            payload.training?.detailStatus === 'read' &&
            payload.training.run?.status === 'completed'
          ) {
            const runId = payload.training.run.id;
            const result = attachRunVisualization(
              await runResults({ runId, status: 'completed' }, runId, signal),
              runId,
              baseUrl,
            );
            payload.training = {
              ...payload.training,
              runDelivery: result.runDelivery,
              links: result.links,
              studentReply: result.studentReply,
            };
            if (payload.scope === 'training' && result.studentReply)
              payload.studentReply = result.studentReply;
          }
        } else if (params.name === 'rdk_plugin_status') {
          if (Object.keys(params.arguments ?? {}).length) throw Error('版本检查不需要参数。');
          const runtime = pluginRuntimeIdentity();
          payload = {
            ok: runtime.loadedSourcesMatch,
            platformLoginRequired: false,
            motionAuthorized: false,
            diagnostics: {
              host,
              layers: {
                mcp: 'responding',
                runtime: runtime.loadedSourcesMatch ? 'verified' : 'blocked',
                authentication: 'not-queried',
                platform: 'not-queried',
                resource: 'not-queried',
                experiment: 'not-selected',
              },
              note: '宿主名称与版本由客户端自行报告，不是原生窗口验收；宿主模型未执行工具时本接口无法替它证明就绪。',
            },
            studentReply: runtime.loadedSourcesMatch
              ? `当前实际运行插件 ${runtime.version}，加载源码核对一致。此项未验证平台连接或实机效果。`
              : '当前进程与分发记录未核对通过，请刷新插件连接后再检查；暂不执行训练或实体操作。',
          };
        } else if (params.name === DEVELOPMENT_TARGET_TOOL.name) {
          payload = await developmentTargets(params.arguments ?? {}, {
            authentication,
            baseUrl,
            request:
              upstream.developmentTarget &&
              ((operation, options) =>
                upstream.developmentTarget(operation, { ...options, signal })),
          });
        } else if (params.name === 'rdk_workshop') {
          const call = async (name, args) =>
            readToolResult(
              await upstream.request('tools/call', { name, arguments: args }, { signal }),
            );
          const args = params.arguments ?? {};
          if (
            args.course === 'dance' &&
            ['continue', 'results'].includes(args.intent) &&
            !args.computeResourceId
          ) {
            return dispatch(
              'tools/call',
              {
                name: LEARNING_GUIDE_TOOL.name,
                arguments: {
                  task: 'dance',
                  intent: 'results',
                  ...(args.contextId && { contextId: args.contextId }),
                },
              },
              signal,
            );
          }
          const catalog =
            args.course === 'recovery' && args.computeResourceId ? await readCatalog(signal) : null;
          payload = await workshopEntry(args, call, {
            remote:
              upstream.workshopSession &&
              ((operation, input, accountId) =>
                upstream.workshopSession(operation, input, {
                  signal,
                  accountId,
                })),
            readResult: async (contextId) =>
              readToolResult(
                await dispatch(
                  'tools/call',
                  { name: 'rdk_experiment_resume', arguments: { contextId } },
                  signal,
                ),
              ),
            readModels: upstream.readModels && (() => upstream.readModels({ signal })),
            courseReadiness:
              upstream.courseReadiness && ((args) => upstream.courseReadiness({ ...args, signal })),
            toolNames: catalog?.tools.map((t) => t.name),
            defaultResourceId: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID,
            authentication,
            signal,
          });
        } else if (params.name === 'rdk_originman_course_brief')
          payload = courseBrief(params.arguments ?? {});
        else if (params.name === 'rdk_originman_training_choice')
          payload = trainingChoice(params.arguments ?? {});
        else if (params.name === LEARNING_GUIDE_TOOL.name) {
          const args = params.arguments ?? {};
          if (args.contextId !== undefined) {
            if (args.intent !== 'results' || args.runId !== undefined)
              throw Error('请用实验标识查询结果，或用原 Run 选择查看与改参。');
            return dispatch(
              'tools/call',
              {
                name: 'rdk_experiment_resume',
                arguments: { contextId: args.contextId },
              },
              signal,
            );
          }
          const useCurrentDance = !args.task || args.task === 'dance';
          const runId =
            args.runId ??
            (useCurrentDance && workflow?.phase === 'dance' ? workflow.runId : undefined);
          if (
            args.section !== undefined &&
            (args.intent !== 'results' ||
              !Number.isInteger(args.section) ||
              args.section < 1 ||
              args.section > 8)
          )
            throw Error('查看逐段建议时，段号应为 1 至 8。');
          if (args.intent === 'results' && args.task === 'recovery' && !runId) {
            return dispatch(
              'tools/call',
              { name: 'rdk_workshop', arguments: { intent: 'results', course: 'recovery' } },
              signal,
            );
          }
          if (['results', 'retry'].includes(args.intent) && !runId) {
            const candidates = await upstream.readLearningRuns?.({
              danceOnly: args.task === 'dance',
              signal,
            });
            payload = runChoice(candidates, baseUrl);
          } else if (['results', 'retry'].includes(args.intent)) {
            if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId))
              throw Error('请提供有效的原 Run 标识。');
            const value = upstream.readTrainingRun
              ? { run: await upstream.readTrainingRun(runId, { signal }) }
              : await readRun(runId, signal);
            const run = value.run ?? value;
            if ((run.id ?? run.runId ?? value.runId) !== runId)
              throw Error('平台未确认这条 Run。请重新打开原运行链接确认账号与记录。');
            const previousLink = runVisualizationLink(baseUrl, runId);
            if (args.intent === 'results') {
              payload = attachRunVisualization(
                await runResults(observe(value, runId), runId, signal),
                runId,
                baseUrl,
                args.section,
              );
            } else if (
              !['completed', 'failed', 'blocked', 'cancelled', 'canceled'].includes(run.status)
            ) {
              payload = attachRunVisualization(
                {
                  ...value,
                  stage: 'wait-original',
                  studentReply: '原 Run 还在运行。先查看本轮进度，结束后再用新参数开一轮。',
                },
                runId,
                baseUrl,
              );
            } else {
              const previous = {
                dance:
                  run.training?.originmanDance ??
                  run.originmanDance ??
                  run.metrics?.danceConfig ??
                  run.metrics?.originmanDance?.config,
                computeResourceId: run.computeResourceId,
                numEnvs: run.training?.numEnvs ?? run.numEnvs,
                modelId: run.modelId,
              };
              payload =
                run.taskId && run.taskId !== 'originman-dance' && !previous.dance
                  ? {
                      stage: 'retry-general',
                      trainingSubmitted: false,
                      studentReply:
                        '这条运行属于其他任务。请先查看原运行中的模型、任务和训练配置，再进入训练工作台选择本轮要改的参数。',
                    }
                  : learningGuide({ ...args, runId }, { previous });
              if (previousLink) payload.studentReply += `\n[查看原 Run](${previousLink})`;
            }
          } else {
            payload = learningGuide(args, { operationId });
            if (payload.stage === 'compute' && authentication && upstream.developmentTarget) {
              const targets = await developmentTargets(payload.nextArguments, {
                authentication,
                baseUrl,
                request: (operation, options) =>
                  upstream.developmentTarget(operation, { ...options, signal }),
              });
              const { nextTool: _tool, nextArguments: _args, ...state } = payload;
              payload = { ...state, ...targets };
            }
            if (payload.platformView && baseUrl) {
              const url = new URL(baseUrl.replace(/\/+$/, '') + '/');
              if (payload.robotId) url.searchParams.set('robot', payload.robotId);
              if (payload.recipe) {
                url.searchParams.set('learningMode', payload.recipe.mode);
                if (payload.recipe.engine)
                  url.searchParams.set('learningEngine', payload.recipe.engine);
                if (payload.recipe.taskId)
                  url.searchParams.set('learningTask', payload.recipe.taskId);
              }
              url.hash = payload.platformView;
              payload.links = { workbench: url.href };
              payload.studioNavigation = {
                tool: 'studio_open_url',
                arguments: { url: url.href },
              };
              const label =
                {
                  overview: '选择机器人',
                  'train/prepare': '打开模型与契约',
                  'train/configure': '打开训练配置',
                  'deploy/preflight': '打开部署预检',
                }[payload.platformView] ?? '打开学习工作台';
              payload.studentReply += `\n[${label}](${url.href})`;
            }
          }
          if (payload.stage === 'ready' && payload.nextArguments?.contextId) {
            confirmedDancePlans.set(payload.nextArguments.contextId, payload.nextArguments);
            if (confirmedDancePlans.size > 32)
              confirmedDancePlans.delete(confirmedDancePlans.keys().next().value);
          }
        } else if (params.name === ORIGINMAN_DANCE_DRAFT_TOOL.name)
          payload = originmanDanceDraft(params.arguments ?? {});
        else if (DANCE_TRAINING_TOOLS.some((tool) => tool.name === params.name)) {
          const plan = confirmedDancePlans.get(params.arguments?.contextId);
          if (plan && !isDeepStrictEqual(params.arguments, plan))
            throw Error('配方已变更，请重新预览并确认本轮参数。');
          payload = await submitDance(params.arguments ?? {}, signal);
        } else if (params.name === 'rdk_classroom_guide')
          payload = classroomGuide(params.arguments ?? {});
        else if (params.name === 'rdk_robot_onboarding_guide')
          payload = onboardingGuide(params.arguments ?? {});
        else if (params.name === 'rdk_robot_acceptance_assess')
          payload = assessOnboarding(params.arguments);
        else if (AUTH_TOOLS.some((t) => t.name === params.name)) {
          if (!authentication) throw Error('当前入口未启用统一登录，请使用本版完整插件入口。');
          payload = await authentication.call(params.name, params.arguments);
          if (params.name === 'rdk_auth_switch_account' || params.name === 'rdk_auth_logout') {
            workflow = null;
            danceFlow = null;
            confirmedDancePlans.clear();
          }
          if (params.name === 'rdk_auth_switch_account') {
            const link = payload.verificationUrl;
            payload.studentReply = link
              ? `[授权另一个学习平台账号](${link})。在浏览器确认后，回来继续 Workshop。`
              : payload.nextAction;
            payload.delivery = '只展示 studentReply。授权后用 rdk_auth_status 确认账号。';
          }
        } else if (params.name === 'rdk_training_wait') {
          payload = await waitForRun(params.arguments ?? {}, signal);
        } else if (params.name === 'rdk_experience_guide')
          payload = {
            trainingChoice: trainingChoice(),
            clientContext: clientContext(),
            formalTraining: {
              trainTool: 'rdk_originman_train',
              evaluateTool: 'rdk_originman_evaluate',
              note: '仅在用户明确选择预算时使用。完整彩排无默认预算；默认在Workshop页面选择，只有高级手动流程才在聊天引导，不自动扩训。',
            },
            course: {
              ...ORIGINMAN_COURSE,
              links: courseLinks(env.RDK_SIM2REAL_MCP_BASE_URL),
            },
            learnerInterface: {
              entryPrompt: '带我开始 Workshop',
              locale: 'zh-CN',
              responseOrder: ['当前进度', '本次结果', '下一步'],
              notifyOn: ['stage-change', 'blocked', 'selection-required', 'completed'],
              diagnostics: 'on-demand',
              preferredSurfaces: ['host-workbench', 'browser-link', 'concise-text'],
              inlineAppAvailable: uiEnabled,
              note: uiEnabled
                ? '已协商MCP Apps；是否渲染和播放仍需宿主实际验收。'
                : '当前宿主未协商内联视图；使用平台实验页或简短文字。',
            },
            shortTraining: {
              intent:
                '一句话要求OriginMan短训练、对比效果和回放时使用；无需用户提供UUID或技术参数。',
              course:
                'OriginMan 受扰恢复：完整课程材料由短训工具内部校验，无需手工填写模型或训练参数。',
              manifestSource:
                'bundled-reference-contract; verify against registered model, not retrieved registration',
              courseResourceConfigured: Boolean(env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID),
              operation: (() => {
                const id = operationId;
                return {
                  contextId: id,
                  groupId: id,
                  trainIdempotencyKey: id + '-train',
                  evaluationIdempotencyKey: id + '-eval',
                  note: '本次新训练使用此组标识；重试和评测保留，勿重新生成。',
                };
              })(),
              defaults: {
                backend: 'local',
                taskId: 'originman-recovery',
                profile: 'standard',
                engine: 'originman-recovery-reflect',
                algorithm: 'sac',
                numEnvs: 4,
                maxIterations: 32,
                originmanWorkshop: {
                  phase: 'train',
                  groupId: operationId,
                  timesteps: 8192,
                  seed: 7,
                  pushMaxForce: 8.1,
                },
              },
              steps: [
                '完整Workshop先做参考观察：由宿主打开course.links.simulation，在页面启动基础PD并实际观察运行，再执行下面的训练。仅打开入口不算观察完成；没有页面操作或观察能力时先明确由学员完成此步，不先训练再补看。用户明确只要求训练时按其范围执行。',
                '第一步：只传contextId调用rdk_originman_short_train({contextId:operation.contextId})，不要复制manifest.modelId或自行挑资源。此工具执行完整manifest校验、当前账号课程模型/明确资源匹配、健康检查、必填参数装配与单次提交。不要手工重复model_validate或training_submit，不调用experience_prepare/workshop_catalog。',
                '第二步：首次rdk_training_wait({runId:返回的submission.runId})；若仍在运行，下次必须原样使用该回执nextPollArguments接续查询（含pollCursor），直到completed。等待窗口正常结束不是超时错误。失败立即停止，不换contextId、资源或参数重试。',
                '第三步：rdk_originman_short_evaluate({contextId:同一标识})；只允许已完成训练，自动冻结sourceRunId、groupId与参数。用rdk_training_wait及返回的nextPollArguments接续等待同一评测Run至终态。',
                '第四步：rdk_experiment_resume({contextId:同一标识})，核对本次父Run与摘要，展示original/tuned/rl实际对比。优先打开links.experiment；旧平台打开links.workbench并按selection选择本次训练与评测，展开页面播放器播放一次，不直接导航媒体URL；rdk_replay_video只适用于真机遥测，本课程禁止调用。MP4/WebM禁止网页正文抓取、独立HTTP探测或新浏览器登录测试。打开后直接收尾，播放器由宿主实际观察，不循环验证。',
                '只输出简短中文四步进度与真实对比；不主动提出延长训练、换seed或复用contextId调优，不推测效果差的原因。调优必须由用户明确要求并建立新实验。短训不保证提升，未做真机。',
                'stopWorkflow=true停止新的写操作，不拼manifest或换工具重交。若回执明确submitted=true且有原runId，只读查询该Run并展示已有结果；未知提交不猜任务。多个资源仅按名称选择；宿主已配置课程资源时沿用它，不换机。',
              ],
            },
            danceTraining: {
              intent:
                '学员明确要训练自定义舞蹈时，使用独立OriginMan dance PPO入口；不复用恢复课合同。',
              manifestSource:
                'originman-dance-manifest.json; 78 observations → 18 actions; local simulation only',
              operation: {
                contextId: operationId,
                trainIdempotencyKey: operationId + '-train',
                note: '同一本轮contextId用于一次提交与重连恢复；要开新一轮实验时重新取得contextId。',
              },
              tool: 'rdk_originman_dance_train',
              parameters: {
                defaultTrainingSteps: 500000,
                bpmRange: [80, 140],
                sectionTypes: ['alternating-arms', 'weight-shift', 'squat-rise', 'open-pose'],
                beatsPerSection: [4, 8, 16],
                maxSections: 8,
                intensityRange: [0.25, 1],
              },
              steps: [
                '保留学员用自然语言描述的舞段、顺序和节奏；如信息不足，只询问缺失的BPM或动作，不擅自追加动作。由助手把描述映射到有界sections。',
                '调用rdk_originman_dance_train({contextId:operation.contextId,dance})。该工具校验独立模型契约、当前账号GPU资源和Worker engine list，使用相同幂等键提交一次；缺资源或引擎时停止。',
                '提交后用rdk_training_wait沿返回runId查询至终态；训练期间可穿插其他Workshop动作。不要重复提交来查询进度。',
                '终态后用rdk_training_status读取同一Run，报告质量门、各段风格评估、策略SHA和回放摘要；qualityGate未通过就明确未达标。出现links.danceVideo时打开本次仿真回放；实际播放由宿主验证。没有链接时说明未生成，不重复提交训练。',
                '只仿真，不调用部署、board policy start或电机工具；历史舞蹈证据与当前Run分开。',
              ],
            },
            guide:
              '场景准备：OriginMan一句话短训练必须按shortTraining.steps调用专用编排工具；完整配方已在专用工具内固定，不要手工提交。其他场景按profile与当前工具能力准备。',
            profile: (() => {
              const p = readProfile();
              return p.robot === 'originman' ? { id: p.id, title: p.title, robot: p.robot } : p;
            })(),
          };
        else {
          const call = async (name, args) =>
            readToolResult(
              await upstream.request('tools/call', { name, arguments: args }, { signal }),
            );
          if (SHORT_TRAINING_TOOLS.some((t) => t.name === params.name)) {
            const catalog = await readCatalog(signal);
            payload = await shortTraining(params.name, params.arguments, call, {
              directory: contextDirectory,
              toolNames: catalog.tools.map((t) => t.name),
              submitSchema: catalog.tools.find((t) => t.name === 'rdk_training_submit')
                ?.inputSchema,
              defaultResourceId: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID,
              courseReadiness:
                upstream.courseReadiness &&
                ((args) => upstream.courseReadiness({ ...args, signal })),
              readModels: upstream.readModels && (() => upstream.readModels({ signal })),
              remote:
                upstream.experimentSession &&
                ((operation, input) => upstream.experimentSession(operation, input, { signal })),
            });
          } else if (EXPERIMENT_TOOLS.some((t) => t.name === params.name)) {
            payload = await experimentContext(
              params.name === 'rdk_experiment_remember' ? 'remember' : 'resume',
              params.arguments,
              call,
              {
                directory: contextDirectory,
                remote:
                  upstream.experimentSession &&
                  ((operation, input) => upstream.experimentSession(operation, input, { signal })),
              },
            );
            if (params.name === 'rdk_experiment_resume' && payload.links?.experiment) {
              payload = { ...payload, ...workshopPageNavigation(payload.links.experiment) };
            }
          } else {
            const catalog = await readCatalog(signal);
            const status = await call('rdk_platform_status', {});
            if (params.name === 'rdk_originman_evaluation_read')
              payload = await readOriginmanEvaluation(params.arguments, call);
            else if (params.name === 'rdk_training_prepare')
              payload = await prepareTraining(
                params.arguments,
                call,
                catalog.tools.map((t) => t.name),
                {
                  courseReadiness:
                    upstream.courseReadiness &&
                    ((args) => upstream.courseReadiness({ ...args, signal })),
                },
              );
            else if (params.name === 'rdk_workflow_inspect')
              payload = await inspectWorkflow(
                params.arguments ?? {},
                call,
                catalog.tools.map((t) => t.name),
              );
            else
              payload = await prepareExperience(params.arguments?.profile ?? readProfile(), call, {
                baseUrl: status.baseUrl,
                tools: catalog.tools.map((t) => t.name),
                action: params.arguments?.action ?? 'check',
              });
          }
        }
        if (['rdk_originman_short_train', 'rdk_originman_train'].includes(params.name)) {
          const runId = payload.submission?.runId ?? payload.experiment?.training?.runId;
          if (runId) {
            workflow = {
              contextId: params.arguments.contextId,
              runId,
              stopped: false,
              completed: false,
            };
            payload = {
              ...payload,
              experiment: {
                ...payload.experiment,
                training: observe(payload.experiment?.training, runId),
              },
            };
          }
        }
        if (['rdk_originman_short_evaluate', 'rdk_originman_evaluate'].includes(params.name)) {
          const runId = payload.submission?.runId ?? payload.experiment?.evaluation?.runId;
          workflow ??= {
            contextId: params.arguments.contextId,
            runId: payload.experiment?.training?.runId,
          };
          if (runId) {
            workflow.evaluationRunId = runId;
            payload = {
              ...payload,
              experiment: {
                ...payload.experiment,
                evaluation: observe(payload.experiment?.evaluation, runId),
              },
            };
          }
        }
        if (
          EXPERIMENT_TOOLS.some((t) => t.name === params.name) &&
          (payload.training?.taskId === 'originman-recovery' ||
            payload.training?.metrics?.originmanWorkshop?.phase === 'train')
        ) {
          workflow = {
            contextId: payload.contextId,
            runId: payload.training.runId,
            evaluationRunId: payload.evaluation?.runId,
            stopped:
              ['failed', 'blocked', 'cancelled'].includes(payload.training.status) ||
              ['failed', 'blocked', 'cancelled'].includes(payload.evaluation?.status),
            completed:
              payload.training.status === 'completed' && payload.evaluation?.status === 'completed',
          };
        }
        if (params.name === 'rdk_originman_dance_train') {
          const runId = payload.submission?.runId;
          if (runId) {
            workflow = {
              contextId: params.arguments.contextId,
              runId,
              phase: 'dance',
              stopped: false,
              completed: false,
            };
            payload = attachRunVisualization(
              payload,
              runId,
              authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL,
            );
            payload.nextTool = DANCE_ACCEPTANCE_TOOL.name;
            payload.nextArguments = { runId };
            payload.nextAction = '使用 nextTool 和 nextArguments 等待本轮结束并自动验收。';
            payload.delivery =
              '按 studioNavigation 打开本轮进度；继续执行 nextTool，直到结果页显示独立仿真验收。';
            const previous = runVisualizationLink(baseUrl, params.arguments.previousRunId);
            if (previous && params.arguments.previousRunId !== runId) {
              payload.links = { ...payload.links, previousRun: previous };
              payload.studentReply = (payload.studentReply ?? '') + `\n[对照原 Run](${previous})`;
            }
          }
        } else if (
          SHORT_TRAINING_TOOLS.some((tool) => tool.name === params.name) ||
          ['rdk_originman_short_train', 'rdk_originman_train'].includes(params.name)
        ) {
          const runId = payload.submission?.runId ?? payload.experiment?.training?.runId;
          if (runId)
            payload = attachRunVisualization(
              payload,
              runId,
              authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL,
            );
        }
        if (params.name === 'rdk_training_wait') payload = observe(payload, params.arguments.runId);
        if (params.name === 'rdk_training_wait')
          payload = await runResults(payload, params.arguments.runId, signal);
        if (params.name === 'rdk_training_wait')
          payload = attachRunVisualization(
            payload,
            params.arguments.runId,
            authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL,
          );
        if (
          workflow?.stopped &&
          (sameContext || sameRun) &&
          !['rdk_workshop', LEARNING_GUIDE_TOOL.name, WORKSPACE_EVIDENCE_TOOL.name].includes(
            params.name,
          )
        )
          payload = {
            ...payload,
            stopWorkflow: true,
            retryAllowed: false,
            nextAction:
              '停止新的提交，保留原Run与原错误；可按原Run只读查询已有状态和结果，不改标识、模型、资源或参数重交。',
          };
        if (
          SHORT_TRAINING_TOOLS.some((t) => t.name === params.name) ||
          EXPERIMENT_TOOLS.some((t) => t.name === params.name)
        ) {
          const studentReply = experimentStudentReply(payload);
          if (studentReply) payload = { ...payload, studentReply };
        }
        payload = { ...payload, pluginRuntime: pluginRuntimeIdentity() };
        return {
          content: [
            {
              type: 'text',
              text:
                params.name === 'rdk_plugin_status' ||
                params.name === 'rdk_originman_course_brief' ||
                (params.name === 'rdk_classroom_guide' && params.arguments?.detail !== 'full')
                  ? payload.studentReply
                  : JSON.stringify(
                      EXPERIMENT_TOOLS.some((t) => t.name === params.name)
                        ? experimentModelResult(payload)
                        : params.name === 'rdk_workshop'
                          ? {
                              ...(payload.training ? experimentModelResult(payload) : {}),
                              contextId: payload.contextId,
                              course: payload.course,
                              studentReply: payload.studentReply,
                              links: payload.links,
                              stage: payload.stage,
                              submission: payload.submission,
                              delivery: payload.delivery,
                              qoderNavigation: payload.qoderNavigation,
                              studioNavigation: payload.studioNavigation,
                              pluginRuntime: payload.pluginRuntime,
                            }
                          : payload,
                    ),
            },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        const code = error.platformCode ?? error.code ?? '';
        const stop =
          error.stopWorkflow ??
          (SHORT_TRAINING_TOOLS.some((t) => t.name === params.name) &&
            !code.endsWith('_SELECTION_REQUIRED') &&
            code !== 'SIM2REAL_ENGINE_PREFLIGHT_BUSY');
        if (stop && (sameContext || sameRun)) workflow.stopped = true;
        const payload = {
          ok: false,
          ...(stop ? { stopWorkflow: true, retryAllowed: false } : {}),
          ...(code === 'SUBMISSION_REFERENCE_SAVE_FAILED' &&
          error.details?.submitted === true &&
          error.details?.runId
            ? {
                recovery: {
                  submissionConfirmed: true,
                  readOnly: true,
                  runId: error.details.runId,
                  phase: error.details.phase,
                  nextAction:
                    '任务已提交；按此原Run只读查询，评测完成后读取同源结果，不重新提交。引用恢复失败再交维护者处理。',
                },
              }
            : {}),
          ...(params.name === DANCE_ITERATION_TOOL.name && {
            nextTool: DANCE_ITERATION_TOOL.name,
            nextAction:
              '修正自动迭代入口的参数后接续原实验。若尚无续跑标识，首次输入 totalSteps 和 dance（bpm、sections）。禁止改用普通训练。',
          }),
          error: {
            message: error.message,
            platformCode: error.platformCode ?? error.code ?? null,
            httpStatus: error.httpStatus ?? null,
            ...(error.needsLogin !== undefined ? { needsLogin: error.needsLogin } : {}),
            ...(error.nextAction ? { nextAction: error.nextAction } : {}),
            ...(error.details ? { details: error.details } : {}),
            ...(error.stopWorkflow !== undefined
              ? {
                  stopWorkflow: error.stopWorkflow,
                  retryAllowed: !error.stopWorkflow,
                }
              : {}),
          },
        };
        return enrichToolError(
          {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
          },
          params.name,
        );
      }
    }
    if (
      method === 'tools/call' &&
      upstream.readTelemetrySummary &&
      ['rdk_telemetry_list', 'rdk_runs_replay'].includes(params.name)
    ) {
      try {
        const summary = await upstream.readTelemetrySummary(params.name, params.arguments ?? {}, {
          signal,
        });
        if (summary) {
          let value = summary;
          const runId = params.arguments?.runId;
          if (
            params.name === 'rdk_runs_replay' &&
            summary.frameCount === 0 &&
            summary.runId === runId &&
            upstream.readTrainingRun
          ) {
            try {
              const run = await upstream.readTrainingRun(runId, { signal });
              if (run?.id === runId) {
                const preview = await verifiedPreview({ run }, runId, signal);
                const danceVideo = preview.links?.danceVideo;
                if (danceVideo) {
                  const playback = new URL(runVisualizationLink(baseUrl, runId, danceVideo));
                  playback.hash = 'replay-heading';
                  value = {
                    ...summary,
                    replayKind: 'simulation',
                    links: { ...summary.links, danceVideo, replay: playback.href },
                    studentReply: `暂无通用遥测帧。[打开本轮仿真回放](${playback.href})`,
                  };
                }
              }
            } catch {
              signal?.throwIfAborted();
            }
          }
          return {
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        }
      } catch {
        signal?.throwIfAborted();
      }
    }
    const response = await upstream.request(method, params, { signal });
    if (
      method === 'tools/call' &&
      params.name === 'rdk_platform_status' &&
      (response.structuredContent || !response.isError)
    ) {
      const status = response.structuredContent ?? readToolResult(response);
      const workbench = baseUrl ? new URL(baseUrl.replace(/\/+$/, '') + '/') : null;
      if (workbench) workbench.hash = 'overview';
      const connection =
        status.canAccessWorkspace === true
          ? '学习平台已连接，可以读取当前工作区。'
          : status.health?.ready === true
            ? status.authentication?.needsLogin === false
              ? '学习平台已就绪，当前账号的授权状态暂未核实。'
              : '学习平台已就绪。说“连接学习平台”即可授权查看你的工作区。'
            : '暂时无法确认学习平台已就绪。';
      const studentReply = [
        connection,
        '你可以按机型和任务进入仿真与录制，配置强化学习或模仿学习，查看本轮评测、回放和策略文件。接入真机后，可以先做部署预检。',
        workbench ? `[打开机器人学习工作台](${workbench.href})` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const value = { ...status, studentReply };
      return {
        ...response,
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      };
    }
    if (
      method === 'tools/call' &&
      params.name === 'rdk_workshop_catalog' &&
      !response.isError &&
      baseUrl
    ) {
      const catalog = readToolResult(response);
      const dance = workshopPreview(baseUrl);
      const recovery = workshopPreview(baseUrl, 'recovery');
      const value = {
        ...catalog,
        ...dance,
        workshopUrls: { dance: dance.entryUrl, recovery: recovery.entryUrl },
        nextTool: 'rdk_workshop',
        nextArguments: { intent: 'new', course: 'dance' },
        studentReply: `[打开 OriginMan 舞蹈 Workshop](${dance.entryUrl})。也可选择[受扰恢复课程](${recovery.entryUrl})。`,
      };
      return {
        ...response,
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      };
    }
    if (method === 'tools/call' && params.name === 'rdk_simulator_open' && response.isError) {
      const args = params.arguments ?? {};
      const referenceOnly =
        Object.keys(args).every((key) => key === 'robot') &&
        (args.robot === undefined || args.robot === 'microduck');
      if (referenceOnly) {
        try {
          readToolResult(response);
        } catch (error) {
          if (error.platformCode !== 'SIM2REAL_API_NOT_FOUND' || error.httpStatus !== 404)
            return response;
          try {
            const overview = readToolResult(
              await upstream.request(
                method,
                {
                  name: 'rdk_workspace_overview',
                  arguments: {},
                },
                { signal },
              ),
            );
            const entry = workspaceReferenceEntry(overview);
            if (entry)
              return {
                structuredContent: entry,
                content: [{ type: 'text', text: JSON.stringify(entry) }],
              };
          } catch {
            signal?.throwIfAborted();
          }
        }
      }
    }
    if (method === 'tools/call' && params.name === 'rdk_training_submit' && !response.isError) {
      const value = readToolResult(response);
      const runId = value.submission?.runId ?? value.runId ?? value.run?.id;
      const attached = attachRunVisualization(
        params.arguments?.engine === 'originman-dance-ppo' && !value.training
          ? { ...value, training: { engine: params.arguments.engine } }
          : value,
        runId,
        authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL,
      );
      if (attached.visualization)
        return {
          ...response,
          structuredContent: attached,
          content: [{ type: 'text', text: JSON.stringify(attached) }],
        };
    }
    if (method === 'tools/call' && params.name === 'rdk_training_status' && !response.isError) {
      let value = await runResults(
        observe(readToolResult(response), params.arguments.runId),
        params.arguments.runId,
        signal,
      );
      value = attachRunVisualization(
        value,
        params.arguments.runId,
        authentication?.audience ?? env.RDK_SIM2REAL_MCP_BASE_URL,
      );
      if (value.stopWorkflow || value.links?.danceVideo || value.visualization)
        return {
          ...response,
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
    }
    return method === 'tools/call' ? enrichToolError(response, params.name) : response;
  };
}

export async function main() {
  const { assertSupportedNode } = await import('../runtime-guard.mjs');
  assertSupportedNode();
  const { connectAuthenticatedCore } = await import('./authenticated-core.mjs');
  const upstream = await connectAuthenticatedCore();
  const dispatch = experienceProxy(upstream, {
    authentication: upstream.authentication,
  });
  const lines = createInterface({ input: process.stdin });
  const active = new Set();
  const controllers = new Map();
  const stop = async () => {
    for (const c of controllers.values()) c.abort();
    lines.close();
    await upstream.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  for await (const line of lines) {
    if (line.length > 1048576) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Request too large.' },
        }) + '\n',
      );
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON.' },
        }) + '\n',
      );
      continue;
    }
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.method !== 'string'
    ) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32600, message: 'Invalid request.' },
        }) + '\n',
      );
      continue;
    }
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/cancelled')
        controllers.get(request.params?.requestId)?.abort();
      else upstream.notify(request.method, request.params);
      continue;
    }
    if (controllers.has(request.id)) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32600, message: 'Duplicate request id.' },
        }) + '\n',
      );
      continue;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const task = dispatch(request.method, request.params, controller.signal)
      .then(
        (result) => ({ jsonrpc: '2.0', id: request.id, result }),
        (error) => ({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: error.message },
        }),
      )
      .then((response) => process.stdout.write(JSON.stringify(response) + '\n'));
    active.add(task);
    task.finally(() => {
      active.delete(task);
      controllers.delete(request.id);
    });
  }
  await Promise.allSettled(active);
  await upstream.close();
}
if (isDirectInvocation(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
