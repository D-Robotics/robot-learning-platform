import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Action = { key: string; label: string };
type Plan = {
  title: string;
  description: string;
  note: string;
  action: Action;
  steps: { key: string; title: string; description: string; done: boolean; action: Action }[];
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
    expect(plan.description).toContain('当前选择的是通用 RDK 设备');
    expect(plan.description).toContain('切换到 MicroDuck 示例');
    expect(plan.action).toEqual({ key: 'begin-experience', label: '切换示例并开始体验' });
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
    expect(plan.action.key).toBe('begin-experience');
    expect(plan.note).toContain('无需连接设备或准备训练服务器');
    expect(plan.note).toContain('记录暂存在当前页面');
    expect(plan.note).toContain('刷新前可在示例中导出');
    expect(plan.title).toBe('先体验：录下动作，再回看记录');
    expect(plan.steps.map((step) => step.title)).toEqual([
      '准备示例机器人',
      '录下一段动作',
      '回看动作记录',
      '完成体验',
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
    expect(recorded.action).toEqual({ key: 'replay-experience', label: '回看这段记录' });
    expect(recorded.steps[2].description).toBe(
      '打开采样时间轴，检查这段记录；此处回看数据，不重演三维动作。',
    );
    const reviewed = core.plan({
      productId: 'microduck',
      browserAvailable: true,
      recordingReady: true,
      recordingReviewed: true,
    });
    expect(reviewed.steps.every((step) => step.done)).toBe(true);
    expect(reviewed.title).toBe('已完成动作录制与记录检查');
    expect(reviewed.action).toEqual({ key: 'replay-experience', label: '再次查看记录' });
    expect(reviewed.steps[3].title).toBe('完成体验');
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
  });
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
  it.each(['experience', 'device', 'model'])(
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

  it.each(['device', 'model'])(
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
      expect(plan.steps[3].title).toBe('完成体验');
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
