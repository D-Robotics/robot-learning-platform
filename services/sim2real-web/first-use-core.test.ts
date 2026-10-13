import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Action = { key: string; label: string };
type Plan = {
  title: string;
  description: string;
  note: string;
  action: Action;
  secondaryAction?: Action | null;
  steps: {
    key: string;
    title: string;
    description: string;
    done: boolean;
    action: Action;
    actionEnabled: boolean;
    actionReason: string;
  }[];
};
type FirstUseCore = { plan: (input?: unknown) => Plan };

let core: FirstUseCore;

beforeAll(async () => {
  await import(
    pathToFileURL(fileURLToPath(new URL('./public/first-use-core.js', import.meta.url))).href
  );
  core = (globalThis as unknown as { SimFirstUseCore: FirstUseCore }).SimFirstUseCore;
  if (!core) throw new Error('first-use-core.js did not publish SimFirstUseCore');
});

describe('first-use experience', () => {
  it('switches a generic device to a named example without claiming browser support for that device', () => {
    const plan = core.plan({
      intent: 'experience',
      productId: 'rdk-duck',
      productName: '通用 RDK 设备',
      browserAvailable: true,
    });
    expect(plan.title).toBe('浏览器仿真');
    expect(plan.description).toBe('运行参考仿真，采集观测与动作数据，并回放采样记录。');
    expect(plan.note).toBe('开始时会切换到 MicroDuck 示例。无需设备或训练服务器。');
    expect(plan.action).toEqual({ key: 'begin-experience', label: '打开参考仿真' });
    expect(plan.steps[0].done).toBe(false);
  });

  it('starts browser recording without a model, device, GPU, or training result', () => {
    const plan = core.plan({
      intent: 'experience',
      productId: 'microduck',
      browserAvailable: true,
      hasModel: false,
      hasDevice: false,
      trainingReady: false,
    });
    expect(plan.action).toEqual({ key: 'begin-experience', label: '打开参考仿真' });
    expect(plan.note).toContain('无需设备或训练服务器');
    expect(plan.note).toContain('记录暂存在当前页面');
    expect(plan.note).toContain('刷新前可在示例中导出');
    expect(plan.title).toBe('浏览器仿真');
    expect(plan.description).toBe('运行参考仿真，采集观测与动作数据，并回放采样记录。');
    expect(plan.steps.map((step) => step.title)).toEqual([
      '准备仿真场景',
      '采集动作数据',
      '回放采样数据',
      '完成录制与回放',
    ]);
    expect(plan.steps.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(plan.steps.map((step) => step.key)).toEqual(['simulate', 'train', 'evaluate', 'deploy']);
  });

  it('offers installation help when the simulator was checked and is unavailable', () => {
    const plan = core.plan({ productId: 'microduck', browserAvailable: false, loading: false });
    expect(plan.action.key).toBe('simulator-help');
    expect(plan.description).toContain('暂时不可用');
    expect(plan.steps[0].done).toBe(false);
    expect(plan.steps[0].action.key).toBe('simulator-help');
  });

  it('does not turn unknown browser availability into an installation failure', () => {
    const plan = core.plan({ productId: 'microduck' });
    expect(plan.action.key).toBe('begin-experience');
    expect(plan.steps[0].done).toBe(false);
    expect(plan.description).not.toContain('暂时不可用');
  });

  it('requires both a saved recording and a fully reviewed timeline to complete the experience', () => {
    const recorded = core.plan({
      productId: 'microduck',
      browserAvailable: true,
      recordingReady: true,
      recordingReviewed: false,
    });
    expect(recorded.steps.map((step) => step.done)).toEqual([true, true, false, false]);
    expect(recorded.title).toBe('动作数据已采集');
    expect(recorded.description).toBe('本次观测与动作数据已录制。打开记录，回放采样时间轴。');
    expect(recorded.action).toEqual({ key: 'replay-experience', label: '回放采样数据' });
    expect(recorded.steps[2].description).toBe(
      '打开采样时间轴，回放本次记录；此处展示采样数据，不重演三维动作。',
    );
    const reviewed = core.plan({
      productId: 'microduck',
      browserAvailable: true,
      recordingReady: true,
      recordingReviewed: true,
    });
    expect(reviewed.steps.every((step) => step.done)).toBe(true);
    expect(reviewed.title).toBe('录制与数据回放已完成');
    expect(reviewed.action).toEqual({ key: 'replay-experience', label: '再次回放记录' });
    expect(reviewed.secondaryAction).toEqual({ key: 'train-setup', label: '配置模型训练' });
    expect(reviewed.steps[3].title).toBe('完成录制与回放');
    expect(reviewed.steps[3].description).toContain('浏览器');
    expect(JSON.stringify(reviewed)).not.toMatch(/已部署|部署成功|已训练|训练成功|真机运行/);
  });

  it('does not accept a visited page or a stale review without a saved recording as evidence', () => {
    const plan = core.plan({
      productId: 'microduck',
      browserAvailable: true,
      recordingReady: false,
      recordingReviewed: true,
      visited: ['simulate', 'train', 'evaluate', 'deploy'],
      trainingReady: true,
      evaluationReady: true,
      preflightReady: true,
    });
    expect(plan.steps.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(plan.action.key).toBe('begin-experience');
    expect(plan.secondaryAction).toBeNull();
    expect(plan.steps[2].actionEnabled).toBe(false);
    expect(plan.steps[2].actionReason).toContain('先采集并保存');
    expect(plan.steps[1].actionEnabled).toBe(true);
    expect(plan.steps[3].actionEnabled).toBe(true);
  });

  it('enables replay once a recording exists without requiring a completed review', () => {
    const plan = core.plan({ recordingReady: true, recordingReviewed: false });
    expect(plan.steps[2].actionEnabled).toBe(true);
    expect(plan.steps[2].actionReason).toBe('');
    expect(plan.steps[2].done).toBe(false);
    expect(plan.secondaryAction).toBeNull();
  });
});

describe('first-use model training', () => {
  const compatibleModel = { intent: 'train', hasModel: true, contractValid: true };
  const savedTask = { ...compatibleModel, trainingSubmitted: true };
  const trainedTask = { ...savedTask, trainingReady: true };

  it('starts with a model and checks compatibility before configuring training', () => {
    const empty = core.plan({ intent: 'train' });
    expect(empty.action.key).toBe('model-import');
    expect(empty.steps.map((step) => step.title)).toEqual([
      '选择模型',
      '配置训练',
      '提交与跟踪',
      '查看评测',
    ]);
    expect(empty.steps.every((step) => !step.done)).toBe(true);
    const imported = core.plan({ intent: 'train', hasModel: true });
    expect(imported.action.key).toBe('model-check');
    expect(imported.steps.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(imported.steps[1].action.key).toBe('model-check');
    expect(imported.steps[1].actionEnabled).toBe(true);
  });

  it('keeps configuration incomplete after a page visit and uses a saved Run as completion evidence', () => {
    const visited = core.plan({
      ...compatibleModel,
      visited: ['train-setup'],
      trainingConfigured: true,
      trainingSubmitted: false,
    });
    expect(visited.action.key).toBe('train-setup');
    expect(visited.steps[1].done).toBe(false);
    expect(visited.steps[1].actionEnabled).toBe(true);
    const submitted = core.plan(savedTask);
    expect(submitted.steps[1].done).toBe(true);
    expect(submitted.action.key).toBe('train-status');
  });

  it('tracks an active saved task without offering another submission as the primary action', () => {
    const plan = core.plan({ ...savedTask, trainingActive: true });
    expect(plan.action).toEqual({ key: 'train-status', label: '查看训练进度' });
    expect(plan.description).toContain('排队或运行');
    expect(plan.steps.map((step) => step.done)).toEqual([true, true, false, false]);
    expect(plan.steps[2].actionEnabled).toBe(true);
    expect(plan.steps[3].actionEnabled).toBe(false);
  });

  it('keeps the failed original task accessible for diagnosis and does not claim a result', () => {
    const plan = core.plan({ ...savedTask, trainingFailed: true });
    expect(plan.action).toEqual({ key: 'train-status', label: '查看训练错误' });
    expect(plan.description).toContain('原任务的错误和日志');
    expect(plan.steps.map((step) => step.done)).toEqual([true, true, false, false]);
    expect(plan.steps[2].actionEnabled).toBe(true);
    expect(plan.steps[3].actionEnabled).toBe(false);
  });

  it('looks up a submitted task whose current status is unknown before any resubmission', () => {
    const plan = core.plan(savedTask);
    expect(plan.title).toBe('训练状态待核对');
    expect(plan.action).toEqual({ key: 'train-status', label: '查看原训练任务' });
    expect(plan.steps[2].description).toContain('避免重复提交');
    expect(plan.steps[2].done).toBe(false);
    expect(plan.steps[2].actionEnabled).toBe(true);
  });

  it('offers evaluation only after an actual completed task and does not count training as evaluation', () => {
    const plan = core.plan(trainedTask);
    expect(plan.action).toEqual({ key: 'evaluate', label: '查看模型评测' });
    expect(plan.steps.map((step) => step.done)).toEqual([true, true, true, false]);
    expect(plan.steps[3].actionEnabled).toBe(true);
    expect(plan.steps[3].actionReason).toBe('');
    expect(plan.note).toContain('不会部署或启动设备');
    expect(JSON.stringify(plan)).not.toMatch(/评测已通过|已部署|真机已运行/);
  });

  it('ends with actual training and evaluation records without requiring a device', () => {
    const plan = core.plan({ ...trainedTask, evaluationReady: true, hasDevice: false });
    expect(plan.action.key).toBe('records');
    expect(plan.steps.every((step) => step.done)).toBe(true);
    expect(plan.steps[3].action.key).toBe('records');
    expect(plan.steps[3].description).toContain('已有评测记录');
    expect(JSON.stringify(plan)).not.toMatch(/评测已通过|已部署|真机已运行/);
  });

  it('blocks future task tracking and evaluation while keeping preparation navigation available', () => {
    const plan = core.plan(compatibleModel);
    expect(plan.steps[0].actionEnabled).toBe(true);
    expect(plan.steps[1].actionEnabled).toBe(true);
    expect(plan.steps[2].action.key).toBe('train-status');
    expect(plan.steps[2].actionEnabled).toBe(false);
    expect(plan.steps[2].actionReason).toContain('先提交并保存训练任务');
    expect(plan.steps[3].action.key).toBe('evaluate');
    expect(plan.steps[3].actionEnabled).toBe(false);
    expect(plan.steps[3].actionReason).toContain('需要实际训练结果');
    expect(plan.steps.every((step) => typeof step.actionEnabled === 'boolean')).toBe(true);
  });

  it('rejects downstream completion evidence when model, compatibility, or submission is missing', () => {
    const downstream = { trainingSubmitted: true, trainingReady: true, evaluationReady: true };
    const noModel = core.plan({ intent: 'train', contractValid: true, ...downstream });
    expect(noModel.action.key).toBe('model-import');
    expect(noModel.steps.every((step) => !step.done)).toBe(true);
    const noContract = core.plan({ intent: 'train', hasModel: true, ...downstream });
    expect(noContract.action.key).toBe('model-check');
    expect(noContract.steps.map((step) => step.done)).toEqual([true, false, false, false]);
    const noTask = core.plan({ ...compatibleModel, trainingReady: true, evaluationReady: true });
    expect(noTask.action.key).toBe('train-setup');
    expect(noTask.steps[3].actionEnabled).toBe(false);
  });

  it.each(['trainingActive', 'trainingFailed'])(
    'does not let an old completed result override the current %s task',
    (status) => {
      const plan = core.plan({ ...trainedTask, evaluationReady: true, [status]: true });
      expect(plan.action.key).toBe('train-status');
      expect(plan.steps.map((step) => step.done)).toEqual([true, true, false, false]);
      expect(plan.steps[3].actionEnabled).toBe(false);
    },
  );

  it.each(['true', 'false', 1, -1, {}, []])(
    'requires literal booleans for training evidence %j',
    (value) => {
      const malformedSubmission = core.plan({
        ...compatibleModel,
        trainingSubmitted: value,
        trainingActive: value,
        trainingFailed: value,
        trainingReady: value,
        evaluationReady: value,
      });
      expect(malformedSubmission.action.key).toBe('train-setup');
      expect(malformedSubmission.steps.map((step) => step.done)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      const malformedResult = core.plan({
        ...savedTask,
        trainingActive: value,
        trainingFailed: value,
        trainingReady: value,
        evaluationReady: value,
      });
      expect(malformedResult.action.key).toBe('train-status');
      expect(malformedResult.steps[2].done).toBe(false);
    },
  );
});

describe('first-use device', () => {
  it('keeps an added but disconnected device incomplete and asks for a real connection', () => {
    const plan = core.plan({ intent: 'device', hasDevice: true, deviceConnected: false });
    expect(plan.steps.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(plan.action).toEqual({ key: 'device-setup', label: '连接我的设备' });
    expect(plan.steps[1].description).toContain('等待平台确认设备在线');
  });

  it('requires a model file before compatibility and a preflight after compatibility', () => {
    const connected = { intent: 'device', hasDevice: true, deviceConnected: true };
    expect(core.plan(connected).action.key).toBe('model-import');
    expect(core.plan({ ...connected, hasModel: true }).action.key).toBe('model-check');
    expect(core.plan({ ...connected, hasModel: true, contractValid: true }).action.key).toBe(
      'device-preflight',
    );
  });

  it('labels a successful preflight as a read-only check and never a deployed or running robot', () => {
    const plan = core.plan({
      intent: 'device',
      hasDevice: true,
      deviceConnected: true,
      hasModel: true,
      contractValid: true,
      preflightReady: true,
    });
    expect(plan.title).toBe('设备预检已通过');
    expect(plan.action.key).toBe('records');
    expect(plan.steps.every((step) => step.done)).toBe(true);
    expect(plan.steps[3].description).toContain('只读设备预检');
    expect(plan.note).toContain('不会启动机器人');
    expect(JSON.stringify(plan)).not.toMatch(/部署成功|已部署|已启动|可以直接运行/);
  });
});

describe('first-use model', () => {
  it('guides from import through compatibility before showing training steps', () => {
    expect(core.plan({ intent: 'model' }).action.key).toBe('model-import');
    expect(core.plan({ intent: 'model', hasModel: true }).action.key).toBe('model-check');
    const checked = core.plan({ intent: 'model', hasModel: true, contractValid: true });
    expect(checked.action.key).toBe('train-setup');
    expect(checked.steps[2].done).toBe(false);
    expect(checked.steps[2].description).toContain('目前没有训练或评测结果');
  });

  it('never presents a training result as a completed evaluation', () => {
    const plan = core.plan({
      intent: 'model',
      hasModel: true,
      contractValid: true,
      trainingReady: true,
      evaluationReady: false,
    });
    expect(plan.steps[2].done).toBe(true);
    expect(plan.steps[2].description).toContain('已有训练结果，尚未确认有评测结果');
    expect(plan.steps[2].action).toEqual({ key: 'train-setup', label: '查看训练结果' });
    expect(plan.action.key).toBe('device-preflight');
    expect(JSON.stringify(plan)).not.toMatch(/已有评测结果|评测已完成|评测已通过/);
  });

  it('uses an observed evaluation result even when there is no training result', () => {
    const plan = core.plan({
      intent: 'model',
      hasModel: true,
      contractValid: true,
      trainingReady: false,
      evaluationReady: true,
    });
    expect(plan.steps[2].done).toBe(true);
    expect(plan.steps[2].action.key).toBe('evaluate');
    expect(plan.steps[3].done).toBe(false);
    expect(plan.action.key).toBe('device-preflight');
  });

  it('ends at device preflight records without claiming a real deployment', () => {
    const plan = core.plan({
      intent: 'model',
      hasModel: true,
      contractValid: true,
      evaluationReady: true,
      preflightReady: true,
    });
    expect(plan.action.key).toBe('records');
    expect(plan.steps[3].title).toBe('完成设备预检');
    expect(plan.note).toContain('不会启动机器人');
    expect(JSON.stringify(plan)).not.toMatch(/已部署|部署成功|真机已运行/);
  });
});

describe('first-use availability and malformed evidence', () => {
  it.each(['experience', 'device', 'model', 'train'])(
    'offers a reconnect on a service error for %s',
    (intent) => {
      const plan = core.plan({ intent, serviceError: true });
      expect(plan.action).toEqual({ key: 'refresh', label: '重新连接' });
      expect(plan.description).toContain('暂时无法读取服务状态');
      expect(plan.steps.every((step) => !step.done)).toBe(true);
    },
  );

  it('keeps a loading simulator from prematurely offering installation help', () => {
    const plan = core.plan({ productId: 'microduck', browserAvailable: false, loading: true });
    expect(plan.action).toEqual({ key: 'refresh', label: '正在检查使用条件' });
    expect(plan.description).toContain('正在检查');
    expect(plan.steps[0].done).toBe(false);
  });

  it.each(['device', 'model', 'train'])(
    'guides a visitor to login without fabricating progress for %s',
    (intent) => {
      const plan = core.plan({ intent, authRequired: true });
      expect(plan.action.key).toBe('login');
      expect(plan.steps.every((step) => !step.done)).toBe(true);
    },
  );

  it('keeps local browser experience available to visitors', () => {
    const plan = core.plan({ productId: 'microduck', browserAvailable: true, authRequired: true });
    expect(plan.action.key).toBe('begin-experience');
  });

  it.each([undefined, null, 1, 'device', [], { intent: 'future-mode' }])(
    'defaults safely to experience for unknown input %j',
    (input) => {
      const plan = core.plan(input);
      expect(plan.steps).toHaveLength(4);
      expect(plan.steps[3].title).toBe('完成录制与回放');
      expect(plan.action.key).toBe('begin-experience');
      expect(plan.steps.every((step) => !step.done)).toBe(true);
    },
  );

  it.each(['true', 'false', 1, -1, {}, []])(
    'does not coerce malformed completion evidence %j',
    (value) => {
      const plan = core.plan({
        intent: 'model',
        hasModel: value,
        contractValid: value,
        trainingReady: value,
        evaluationReady: value,
        preflightReady: value,
        loading: value,
        serviceError: value,
        authRequired: value,
      });
      expect(plan.steps.every((step) => !step.done)).toBe(true);
      expect(plan.action.key).toBe('model-import');
    },
  );

  it('does not mutate the caller or share mutable plans between calls', () => {
    const input = Object.freeze({ intent: 'device', hasDevice: true });
    const first = core.plan(input);
    first.steps[0].done = false;
    first.action.key = 'unexpected';
    const second = core.plan(input);
    expect(second.steps[0].done).toBe(true);
    expect(second.action.key).toBe('device-setup');
    expect(input).toEqual({ intent: 'device', hasDevice: true });
  });
});
