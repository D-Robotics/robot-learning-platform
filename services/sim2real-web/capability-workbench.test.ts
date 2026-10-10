import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, 'public', 'capability-workbench.js'), 'utf8');
const windows: Array<InstanceType<typeof JSDOM>['window']> = [];
type Capability = { id: string; description: string; readOnly: boolean; bound: boolean };
const workspace: Capability = {
  id: 'rdk_workspace_overview',
  description: '读取模型、设备和运行',
  readOnly: true,
  bound: true,
};
const runs: Capability = {
  id: 'rdk_runs_list',
  description: '列出训练运行',
  readOnly: true,
  bound: true,
};
const start: Capability = {
  id: 'rdk_board_policy_start',
  description: '在三重安全开关通过后启动板端策略',
  readOnly: false,
  bound: true,
};

function boot(
  items: Capability[],
  options: {
    ready?: boolean;
    request?: ReturnType<typeof vi.fn>;
    onUsePrompt?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const dom = new JSDOM(
    '<details id="catalog" hidden><summary>能力目录<span id="count"></span></summary><ul id="list"></ul></details>',
    { url: 'http://localhost/sim2real/', runScripts: 'outside-only' },
  );
  windows.push(dom.window);
  dom.window.eval(source);
  const document = dom.window.document;
  const request =
    options.request ||
    vi.fn(async () => ({ ok: true, models: [], runs: [], deployments: [], devices: [] }));
  const onUsePrompt = options.onUsePrompt || vi.fn(() => true);
  const onNavigate = vi.fn();
  const workbench = (
    dom.window as unknown as {
      RdkCapabilityWorkbench: {
        mount: (args: unknown) => {
          started: (id: string) => void;
          finished: (id: string, outcome: unknown) => void;
          failed: (id: string, error: unknown) => void;
        };
      };
    }
  ).RdkCapabilityWorkbench.mount({
    panel: document.querySelector('#catalog'),
    list: document.querySelector('#list'),
    count: document.querySelector('#count'),
    capabilities: {
      runtime: options.ready === false ? 'legacy' : 'dsh',
      dsh: { initialized: options.ready !== false, capabilities: items },
    },
    request,
    onUsePrompt,
    onNavigate,
  });
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-capability-id="${id}"]`)!;
  return { window: dom.window, document, request, onUsePrompt, onNavigate, workbench, row };
}

function clickText(row: HTMLElement, text: string) {
  const button = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === text,
  );
  if (!button) throw new Error(`missing button ${text}`);
  button.click();
  return button;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

describe('atomic capability workbench', () => {
  it('performs no background execution, then uses an authenticated GET with real empty evidence', async () => {
    const request = vi.fn(async () => ({ ok: true, runs: [], total: 0 }));
    const ui = boot([runs], { ready: false, request });
    expect(request).not.toHaveBeenCalled();
    const button = clickText(ui.row(runs.id), '只读试用');
    expect(button.disabled).toBe(true);
    await settle();
    expect(request).toHaveBeenCalledExactlyOnceWith('/sim2real/runs?limit=10', { method: 'GET' });
    expect(ui.row(runs.id).querySelector('.capability-result')?.getAttribute('data-state')).toBe(
      'empty',
    );
    expect(ui.row(runs.id).textContent).toContain('当前账号暂无记录');
    expect(button.disabled).toBe(false);
    expect(ui.onUsePrompt).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, message: '上游查询失败' }, '上游查询失败'],
    [{ ok: true }, '查询响应缺少预期列表'],
  ])(
    'does not label an invalid or failed response as a successful empty list',
    async (payload, message) => {
      const ui = boot([runs], { request: vi.fn(async () => payload) });
      clickText(ui.row(runs.id), '只读试用');
      await settle();
      expect(ui.row(runs.id).querySelector('.capability-result')?.getAttribute('data-state')).toBe(
        'failed',
      );
      expect(ui.row(runs.id).textContent).toContain(message);
      expect(ui.row(runs.id).textContent).not.toContain('查询完成');
    },
  );

  it('preserves permission failures, provides recovery, and never falls back to unscoped data', async () => {
    const error = Object.assign(new Error('权限不足'), { status: 403 });
    const request = vi.fn(async () => {
      throw error;
    });
    const ui = boot([workspace], { request });
    clickText(ui.row(workspace.id), '只读试用');
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(ui.row(workspace.id).textContent).toContain('权限不足');
    expect(ui.row(workspace.id).textContent).toContain('使用有权限的账号或资源');
    expect(
      ui.row(workspace.id).querySelector('.capability-result')?.getAttribute('data-state'),
    ).toBe('failed');
  });

  it('only prepares a gated operation and keeps unbound tools visibly unavailable', () => {
    const unbound = { ...start, id: 'rdk_unknown_write', bound: false };
    const ui = boot([start, unbound]);
    const sample = ui.row(start.id).querySelector<HTMLTextAreaElement>('textarea')!;
    expect(sample.value).toContain('本次只准备计划');
    clickText(ui.row(start.id), '准备受控计划');
    expect(ui.onUsePrompt).toHaveBeenCalledExactlyOnceWith(sample.value, start);
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.row(start.id).textContent).toContain('本次尚未执行');
    expect(ui.row(unbound.id).textContent).toContain('Agent 未绑定');
    expect(ui.row(unbound.id).querySelector('button')?.disabled).toBe(true);
    expect(ui.row(unbound.id).querySelectorAll('button').length).toBe(2);
  });

  it('does not call unknown endpoints or equate an Agent reply with execution evidence', () => {
    const unknown = {
      id: 'rdk_unknown_read',
      description: '<img src=x onerror=alert(1)>',
      readOnly: true,
      bound: true,
    };
    const ui = boot([unknown]);
    expect(ui.row(unknown.id).querySelector('img')).toBeNull();
    expect(ui.row(unknown.id).querySelector('button')?.textContent).toBe('准备 Agent 指令');
    ui.workbench.finished(unknown.id, {
      text: '已经完成了',
      toolTrail: [{ name: workspace.id, ok: true }],
    });
    expect(ui.row(unknown.id).querySelector('.capability-result')?.getAttribute('data-state')).toBe(
      'unverified',
    );
    expect(ui.row(unknown.id).textContent).toContain('尚无该工具成功执行的证据');
    ui.workbench.finished(unknown.id, {
      text: '未完成',
      toolTrail: [
        { name: unknown.id, ok: false },
        { name: unknown.id, ok: true },
      ],
    });
    expect(ui.row(unknown.id).querySelector('.capability-result')?.getAttribute('data-state')).toBe(
      'failed',
    );
    ui.workbench.finished(unknown.id, {
      text: '读取完成',
      toolTrail: [{ name: unknown.id, ok: true }],
    });
    expect(ui.row(unknown.id).querySelector('.capability-result')?.getAttribute('data-state')).toBe(
      'completed',
    );
    expect(ui.request).not.toHaveBeenCalled();
  });

  it('filters real capabilities and shows why an empty search has no results', () => {
    const ui = boot([workspace, start, { ...runs, bound: false }]);
    const filter = ui.document.querySelector<HTMLSelectElement>('select')!;
    filter.value = 'gated';
    filter.dispatchEvent(new ui.window.Event('change'));
    expect(ui.row(workspace.id).hidden).toBe(true);
    expect(ui.row(start.id).hidden).toBe(false);
    const search = ui.document.querySelector<HTMLInputElement>('input')!;
    search.value = '不存在';
    search.dispatchEvent(new ui.window.Event('input'));
    expect(ui.document.querySelector('[data-capability-controls]')?.textContent).toContain(
      '显示 0 / 3 项',
    );
    expect(
      [...ui.document.querySelectorAll('p')].find((p) => p.textContent?.includes('没有匹配'))
        ?.hidden,
    ).toBe(false);
  });

  it('bounds returned evidence and excludes credentials while preserving configured status', async () => {
    const ui = boot([runs], {
      request: vi.fn(async () => ({
        ok: true,
        runs: [
          {
            id: 'run-1',
            token: 'secret-value',
            tokenConfigured: true,
            password: 'pass',
            nested: { authorization: 'Bearer secret' },
          },
        ],
        total: 1,
      })),
    });
    clickText(ui.row(runs.id), '只读试用');
    await settle();
    const evidence = ui.row(runs.id).querySelector('pre')?.textContent;
    expect(evidence).toContain('run-1');
    expect(evidence).toContain('tokenConfigured');
    expect(evidence).not.toContain('secret-value');
    expect(evidence).not.toContain('password');
    expect(evidence).not.toContain('Bearer');
    clickText(ui.row(runs.id), '打开证据与记录');
    expect(ui.onNavigate).toHaveBeenCalledExactlyOnceWith('records', runs);
  });
});
