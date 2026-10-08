import { describe, expect, it } from 'vitest';

import { deriveRdkGoldenPath } from './rdk-golden-path.js';

const base = {
  datasets: [],
  runs: [],
  evaluations: [],
  deployments: [],
};

describe('RDK Golden Path', () => {
  it('explains the first action when a workspace is empty', () => {
    const result = deriveRdkGoldenPath(base);
    expect(result.progress).toEqual({ completed: 0, total: 6, percent: 0 });
    expect(result.nextAction).toMatchObject({ stage: 'task', label: '选择任务' });
    expect(result.readyForRdkPreflight).toBe(false);
  });

  it('treats a missing dataset as optional for the simulation loop, not as a blocker', () => {
    // 空数据集曾经被标成 blocked，使"准备数据"抢占了全局下一步，与上手
    // 清单（先在仿真中验证，不需要数据集）互相矛盾。
    const result = deriveRdkGoldenPath({ ...base, taskId: 'balance', modelId: 'model-1' });
    expect(result.stages.find((item) => item.key === 'dataset')?.state).toBe('pending');
    expect(result.nextAction).toMatchObject({ stage: 'train' });
    expect(result.nextAction?.label).not.toBe('准备数据');
  });

  it('still routes the next action to a genuinely actionable dataset stage', () => {
    const result = deriveRdkGoldenPath({
      ...base,
      taskId: 'balance',
      modelId: 'model-1',
      datasets: [
        {
          id: 'dataset-1',
          name: '示教数据',
          status: 'registered',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(result.stages.find((item) => item.key === 'dataset')?.state).toBe('ready');
    expect(result.nextAction?.stage).toBe('dataset');
  });

  it('does not treat a registered dataset or a failed run as release-ready', () => {
    const result = deriveRdkGoldenPath({
      ...base,
      taskId: 'goal-navigation-clear-arena',
      modelId: 'model-1',
      datasets: [
        {
          id: 'dataset-1',
          name: '示教数据',
          status: 'registered',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      runs: [
        {
          id: 'run-1',
          modelId: 'model-1',
          taskId: 'goal-navigation-clear-arena',
          backend: 'local',
          status: 'failed',
          summary: 'worker 缺少依赖',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(result.stages.find((item) => item.key === 'dataset')?.state).toBe('ready');
    expect(result.stages.find((item) => item.key === 'train')?.state).toBe('failed');
    expect(result.readyForRdkPreflight).toBe(false);
    expect(result.nextAction?.stage).toBe('dataset');
  });

  it('requires attested device evidence before declaring the flywheel complete', () => {
    const result = deriveRdkGoldenPath({
      ...base,
      taskId: 'goal-navigation-clear-arena',
      modelId: 'model-1',
      datasets: [
        {
          id: 'dataset-1',
          name: 'RDK 数据',
          status: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      runs: [
        {
          id: 'run-1',
          modelId: 'model-1',
          taskId: 'goal-navigation-clear-arena',
          backend: 'local',
          status: 'completed',
          summary: '训练完成',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      evaluations: [
        {
          id: 'eval-1',
          runId: 'run-1',
          modelId: 'model-1',
          taskId: 'goal-navigation-clear-arena',
          datasetIds: ['dataset-1'],
          status: 'passed',
          summary: '通过仿真评测',
          source: 'platform',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      deployments: [
        {
          id: 'deployment-1',
          modelId: 'model-1',
          deviceId: 'x5-1',
          targetPlatform: 'rdk-x5',
          mode: 'preflight',
          status: 'ready',
          summary: '只读预检通过',
          compatibility: {} as never,
          steps: [],
          createdAt: '2026-01-04T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
        },
      ],
    });
    expect(result.readyForRdkPreflight).toBe(true);
    expect(result.stages.find((item) => item.key === 'feedback')?.state).toBe('pending');
    expect(result.nextAction?.stage).toBe('deploy');
  });
});
