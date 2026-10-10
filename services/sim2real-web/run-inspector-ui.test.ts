import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const [coreSource, inspectorSource] = await Promise.all([
  readFile(path.join(directory, 'run-inspector-core.js'), 'utf8'),
  readFile(path.join(directory, 'run-inspector.js'), 'utf8'),
]);
const windows: Array<InstanceType<typeof JSDOM>['window']> = [];
afterEach(() => {
  windows.splice(0).forEach((window) => window.close());
  vi.restoreAllMocks();
});

function boot() {
  const dom = new JSDOM('<!doctype html><rdk-run-inspector></rdk-run-inspector>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/robotics-learning/',
  });
  const window = dom.window;
  windows.push(window);
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const calls: Array<{ url: string; options: RequestInit }> = [];
  window.fetch = (async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    const runId = url.includes('/runs/b') ? 'b' : 'a';
    const body = url.endsWith('/replay')
      ? {
          frames:
            runId === 'a'
              ? [
                  { t: 100, observation: [2, 3], action: [0.1], reward: 1 },
                  { t: 102, observation: [4, 5], action: [0.2], reward: 10000, fall: true },
                  { t: 110, observation: [6, 7] },
                ]
              : [
                  { t: 7, observation: [8] },
                  { t: 8, observation: [9], done: true },
                ],
        }
      : { run: { id: runId, modelId: 'model', summary: `Run ${runId}` } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as any;
  window.eval(coreSource);
  window.eval(inspectorSource);
  const inspector = window.document.querySelector('rdk-run-inspector') as any;
  inspector.configure({
    apiRoot: '/robotics-learning/api/sim2real',
    runs: [{ id: 'a' }, { id: 'b' }],
    manifests: {
      model: { contract: { observationLayout: [{ name: 'gyro', size: 2, unit: 'rad/s' }] } },
    },
  });
  return { window, inspector, calls };
}

describe('Run inspector in the actual DOM', () => {
  it('distinguishes independent demonstration Runs by label and id rather than their shared contract summary', async () => {
    const { inspector } = boot();
    inspector.configure({
      runs: [
        { id: 'source-run-a', label: '示教来源 · turn.jsonl', summary: '模型契约校验完成' },
        { id: 'source-run-b', label: '示教来源 · walk.jsonl', summary: '模型契约校验完成' },
      ],
      requestJson: async (url: string) =>
        url.endsWith('/replay')
          ? { frames: [{ t: 0, reward: 1 }] }
          : {
              run: {
                id: 'source-run-a',
                label: '示教来源 · turn.jsonl',
                summary: '模型契约校验完成',
              },
            },
    });
    expect(inspector.first.select.options[1].textContent).toBe('示教来源 · turn.jsonl · source-r');
    expect(inspector.first.select.options[2].textContent).toBe('示教来源 · walk.jsonl · source-r');
    await inspector.load('source-run-a');
    expect(inspector.querySelector('h4').textContent).toBe('示教来源 · turn.jsonl · source-r');
  });

  it('identifies a local fixture as synthetic evidence before its local provenance', () => {
    const { inspector } = boot();
    inspector.loadLocal({ samples: [{ t: 0, reward: 1 }], source: 'demo-fixture' });
    const pane = inspector.querySelector('.run-inspector-pane');
    expect(pane.textContent).toContain('演示数据 · 不能证明真实设备');
    expect(pane.textContent).not.toContain('本地导入 · 来源未验证');
  });

  it.each(['replay-summary', 'run-summary'])(
    'identifies a saved fixture from the real %s API metadata',
    async (location) => {
      const { inspector } = boot();
      inspector.configure({
        requestJson: async (url: string) =>
          url.endsWith('/replay')
            ? {
                frames: [{ t: 0, reward: 1 }],
                replay: location === 'replay-summary' ? { source: 'demo-fixture' } : {},
              }
            : {
                run: {
                  id: 'a',
                  modelId: 'model',
                  evaluation: {
                    replay: location === 'run-summary' ? { source: 'demo-fixture' } : {},
                  },
                },
              },
      });
      await inspector.load('a');
      expect(inspector.querySelector('.run-inspector-pane').textContent).toContain(
        '演示数据 · 不能证明真实设备',
      );
    },
  );

  it('keeps an explicit fresh replay attestation rejection even when the Run summary was previously attested', async () => {
    const { inspector } = boot();
    inspector.configure({
      requestJson: async (url: string) =>
        url.endsWith('/replay')
          ? { frames: [{ t: 0, reward: 1 }], replay: { source: 'board-agent', attested: false } }
          : {
              run: {
                id: 'a',
                modelId: 'model',
                evaluation: { replay: { source: 'board-agent', attested: true } },
              },
            },
    });
    await inspector.load('a');
    const pane = inspector.querySelector('.run-inspector-pane');
    expect(pane.textContent).toContain('来源未验证 · 可供审阅');
    expect(pane.textContent).not.toContain('服务器标注受信来源');
  });

  it('loads mounted-prefix APIs with credentials, displays one Run, and retains dimension selection on polling', async () => {
    const { inspector, calls } = boot();
    expect(await inspector.load('a')).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      '/robotics-learning/api/sim2real/runs/a',
      '/robotics-learning/api/sim2real/runs/a/replay',
    ]);
    expect(
      calls.every((call) => call.options.credentials === 'same-origin' && !call.options.method),
    ).toBe(true);
    expect(inspector.querySelectorAll('.run-inspector-pane')).toHaveLength(1);
    expect(inspector.second.wrapper.hidden).toBe(true);
    const dimension = inspector.querySelector('.run-inspector-chart select');
    dimension.value = '1';
    inspector.configure({ runs: [{ id: 'a' }, { id: 'b' }] });
    expect(inspector.querySelector('.run-inspector-chart select')).toBe(dimension);
    expect(dimension.value).toBe('1');
    expect(inspector.textContent).toContain('gyro[1] · rad/s');
    expect(inspector.textContent).toContain('未记录相机帧');
  });

  it('aligns irregular samples and explicitly ends a shorter comparison Run', async () => {
    const { inspector } = boot();
    const onSeek = vi.fn();
    inspector.addEventListener('run-inspector-seek', onSeek);
    inspector.configure({ mode: 'compare' });
    expect(await inspector.load('a', 'b')).toBe(true);
    inspector.seek(1.5);
    const panes = inspector.querySelectorAll('.run-inspector-pane');
    expect(panes[0].textContent).toContain('实际采样 t=100.000s');
    expect(panes[1].textContent).toContain('已结束');
    inspector.seek(2);
    expect(onSeek.mock.calls.at(-1)?.[0].detail).toMatchObject({
      elapsed: 2,
      runId: 'a',
      index: 1,
      frame: { t: 102 },
    });
    expect(panes[0].textContent).toContain('实际采样 t=102.000s');
    expect(panes[0].textContent).toContain('源数据未记录奖励分项');
    inspector.querySelector('.run-inspector-raw').open = true;
    inspector.seek(2);
    expect(panes[0].textContent).toContain('rad/s');
  });

  it('event jumps use the original event time and local inspection never writes a Run', () => {
    const { inspector, calls } = boot();
    inspector.loadLocal({
      samples: [
        { t: 10, reward: 1 },
        { t: 12.75, fall: true },
      ],
      modelId: 'model',
      fileName: 'local.jsonl',
      source: 'import',
    });
    expect(calls).toHaveLength(0);
    expect(inspector.textContent).toContain('来源未验证，未创建 Run');
    inspector.querySelector('.run-inspector-events button').click();
    expect(inspector.position.textContent).toBe('2.750s / 2.750s');
    inspector.clear();
    expect(inspector.querySelectorAll('.run-inspector-pane')).toHaveLength(0);
    expect(inspector.position.textContent).toBe('0.000s / 0.000s');
    expect(inspector.playButton.disabled).toBe(true);
  });

  it('advances playback by elapsed wall time, not one recorded frame per animation tick', () => {
    const { window, inspector } = boot();
    let tick: FrameRequestCallback | undefined;
    vi.spyOn(window.performance, 'now').mockReturnValue(0);
    window.requestAnimationFrame = (callback) => {
      tick = callback;
      return 1;
    };
    window.cancelAnimationFrame = () => undefined;
    inspector.loadLocal({
      samples: [
        { t: 100, reward: 1 },
        { t: 102, reward: 2 },
        { t: 110, reward: 3 },
      ],
    });
    inspector.play();
    tick?.(500);
    expect(inspector.position.textContent).toBe('0.500s / 10.000s');
    expect(inspector.querySelector('.run-inspector-pane').textContent).toContain(
      '实际采样 t=100.000s',
    );
    tick?.(2500);
    expect(inspector.position.textContent).toBe('2.500s / 10.000s');
    expect(inspector.querySelector('.run-inspector-pane').textContent).toContain(
      '实际采样 t=102.000s',
    );
  });

  it('clears data when project-scoped Run options no longer contain the loaded Run', async () => {
    const { inspector } = boot();
    await inspector.load('a');
    inspector.configure({ runs: [{ id: 'b' }] });
    expect(inspector.querySelectorAll('.run-inspector-pane')).toHaveLength(0);
    expect(inspector.textContent).toContain('项目或产品已切换');
  });

  it('cancels an initial pending load when its Run leaves the project scope, even if a host ignores abort', async () => {
    const { inspector } = boot();
    let complete: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    inspector.configure({
      requestJson: async (url: string) => {
        await ready;
        return url.endsWith('/replay')
          ? { frames: [{ t: 0, reward: 1 }] }
          : { run: { id: 'a', modelId: 'model' } };
      },
    });
    const loading = inspector.load('a');
    inspector.configure({ runs: [{ id: 'b' }] });
    complete?.();
    expect(await loading).toBe(false);
    expect(inspector.querySelectorAll('.run-inspector-pane')).toHaveLength(0);
    expect(inspector.position.textContent).toBe('0.000s / 0.000s');
    expect(inspector.loadButton.disabled).toBe(false);
  });

  it('uses the host request wrapper and clears local data across a model change', async () => {
    const { inspector, calls } = boot();
    const wrapper = vi.fn(async (url: string, options: { signal: AbortSignal }) => {
      expect(options.signal).toBeTruthy();
      return url.endsWith('/replay')
        ? { frames: [{ t: 0, reward: 2 }] }
        : { run: { id: 'a', modelId: 'model' } };
    });
    inspector.configure({ requestJson: wrapper });
    expect(await inspector.load('a')).toBe(true);
    expect(wrapper.mock.calls.map(([url]) => url)).toEqual(['/runs/a', '/runs/a/replay']);
    expect(calls).toHaveLength(0);
    inspector.loadLocal({ samples: [{ t: 0, reward: 1 }], modelId: 'model' });
    inspector.configure({ manifests: { another: {} } });
    expect(inspector.querySelectorAll('.run-inspector-pane')).toHaveLength(0);
    expect(inspector.textContent).toContain('项目或产品已切换');
  });
});
