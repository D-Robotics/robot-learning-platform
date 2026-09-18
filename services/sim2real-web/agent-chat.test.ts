import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSource = await readFile(path.join(here, 'public', 'agent-chat.js'), 'utf8');
const openWindows: Array<InstanceType<typeof JSDOM>['window']> = [];

function shell() {
  return `
    <button id="agent-floating-toggle" type="button" aria-expanded="false">Agent</button>
    <div id="agent-chat-backdrop" hidden></div>
    <section id="agent-chat-panel" role="dialog" aria-hidden="true" aria-labelledby="agent-chat-title">
      <h2 id="agent-chat-title">Agent</h2>
      <button id="agent-chat-close" type="button">关闭</button>
      <aside>
        <button id="agent-new-session" type="button">新建对话</button>
        <div id="agent-session-list"><button class="agent-session-item" type="button" data-static-current>当前对话</button></div>
      </aside>
      <div id="agent-chat-messages"></div>
      <div id="agent-plan-card"></div>
      <div id="agent-evidence"></div>
      <div id="agent-event-log"></div>
      <form id="agent-chat-form">
        <input id="agent-chat-input" />
        <button type="button" data-agent-stop hidden>停止等待</button>
        <button type="submit">发送</button>
      </form>
    </section>
  `;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function boot(fetchImpl: typeof fetch) {
  const dom = new JSDOM(shell(), {
    url: 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  // agent-chat.js is a same-page classic script: its api() reuses app.js's
  // global request()/ApiError. This harness boots agent-chat without app.js,
  // so provide the contract app.js would supply (URL prefix from the same
  // BASE_PATH heuristic, JSON parsing, ApiError with a stable status field).
  class ApiErrorShim extends Error {
    status: number;
    payload: unknown;
    constructor(message: string, status: number, payload: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload;
    }
  }
  Object.assign(dom.window, {
    fetch: fetchImpl,
    Headers,
    Response,
    ApiError: ApiErrorShim,
    request: async (path: string, options: Record<string, unknown> = {}) => {
      const headers = Object.assign(
        options.body ? { 'content-type': 'application/json' } : {},
        (options.headers as Record<string, string>) || {},
      );
      const response = await fetchImpl(
        '/sim2real/api' + String(path),
        Object.assign({}, options, { credentials: 'same-origin', headers }),
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const body = payload as { message?: string; error?: string };
        throw new ApiErrorShim(
          String(body?.message || body?.error || `请求失败（${response.status}）`),
          response.status,
          payload,
        );
      }
      return payload;
    },
  });
  dom.window.eval(agentSource);
  return dom.window;
}

function wait(milliseconds = 10) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(() => {
  for (const window of openWindows.splice(0)) window.close();
  vi.restoreAllMocks();
});

describe('Agent chat browser behavior', () => {
  it('preserves HTTP status so a disabled DSH endpoint falls back to the guarded planner', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/sim2real/dsh/chat')) {
        return jsonResponse({ ok: false, error: 'DSH_DISABLED' }, 503);
      }
      if (url.endsWith('/api/sim2real/agent/plan')) {
        return jsonResponse({
          plan: {
            goal: '检查工作区',
            safety: 'read-only',
            steps: [{ id: 'step-1', tool: 'workspace.status', label: '读取工作区状态' }],
          },
        });
      }
      if (url.endsWith('/api/sim2real/agent/execute')) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    input.value = '请总结实验';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);

    expect(calls.slice(0, 3)).toEqual([
      '/sim2real/api/sim2real/dsh/chat',
      '/sim2real/api/sim2real/agent/plan',
      '/sim2real/api/sim2real/agent/execute',
    ]);
    expect(window.document.querySelector('#agent-plan-card')?.textContent).toContain('检查工作区');
    expect(window.document.querySelector('#agent-chat-messages')?.textContent).toContain(
      '服务没有返回有效的运行记录',
    );
  });

  it('renders the DSH reasoning trace and tool timeline without leaking them into the reply text', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/sim2real/dsh/chat')) {
        return jsonResponse({
          ok: true,
          text: "I'll check the workspace.\n## 工作区\n- 2 个模型",
          reasoning: '先调 overview 工具，再汇总。',
          toolTrail: [
            { name: 'rdk_workspace_overview', step: 1, ok: true },
            { name: 'rdk_training_submit', step: 2, ok: false },
          ],
          events: [],
        });
      }
      return jsonResponse({ ok: true });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    input.value = '总结工作区';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);

    const messages = window.document.querySelector('#agent-chat-messages');
    if (!messages) throw new Error('missing message log');
    // The English preamble is stripped from the reply body.
    const reply = messages.querySelector('.agent-chat-message-agent p');
    expect(reply?.textContent).not.toContain("I'll check the workspace.");
    expect(reply?.textContent).toContain('工作区');
    // The reasoning renders as a collapsed disclosure, separate from the reply.
    const reasoning = messages.querySelector('.agent-dsh-reasoning');
    expect(reasoning?.textContent).toContain('思考过程');
    expect(reasoning?.querySelector('summary')?.textContent).toContain('思考过程');
    expect(reasoning?.querySelector('p')?.textContent).toContain('先调 overview 工具');
    // The tool timeline renders one row per call, failures marked.
    const trail = messages.querySelectorAll('.agent-dsh-trail-item');
    expect(trail.length).toBe(2);
    expect(trail[0]?.textContent).toContain('读取工作区总览');
    expect(trail[1]?.classList.contains('is-failed')).toBe(true);
    expect(trail[1]?.textContent).toContain('提交训练');
  });

  it('lets the operator stop waiting for a slow request and explains the backend boundary', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/api/sim2real/dsh/chat')) return jsonResponse({ ok: true });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    const stop = window.document.querySelector<HTMLButtonElement>('[data-agent-stop]');
    if (!input || !form || !stop) throw new Error('agent chat fixture is incomplete');
    input.value = '检查设备';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(10);
    expect(stop.hidden).toBe(false);
    stop.click();
    await wait(20);
    expect(window.document.querySelector('#agent-chat-messages')?.textContent).toContain(
      '已停止等待',
    );
    expect(stop.hidden).toBe(true);
  });

  it('traps keyboard focus in the drawer and restores the opener on close', async () => {
    const window = boot(vi.fn(async () => jsonResponse({ ok: true })));
    const launcher = window.document.querySelector<HTMLButtonElement>('#agent-floating-toggle');
    const panel = window.document.querySelector<HTMLElement>('#agent-chat-panel');
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    if (!launcher || !panel || !input) throw new Error('agent chat fixture is incomplete');

    launcher.focus();
    window.setAgentDrawerOpen(true);
    await wait(100);
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(window.document.activeElement).toBe(input);

    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) throw new Error('drawer has no focusable controls');

    last.focus();
    panel.ownerDocument.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(window.document.activeElement).toBe(first);

    first.focus();
    panel.ownerDocument.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(window.document.activeElement).toBe(last);

    window.setAgentDrawerOpen(false);
    await wait(5);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(window.document.activeElement).toBe(launcher);
  });

  /** Three deterministic re-scopings of the same goal, as the server sends them. */
  function planVariants() {
    const base = (
      key: string,
      safety: string,
      steps: Array<{ id: string; tool: string; label: string }>,
    ) => ({
      id: `plan-${key}`,
      goal: '完成仿真、GPU训练并检查 X5',
      safety,
      steps,
    });
    return [
      {
        key: 'fastest',
        label: '最快',
        rationale: '只跑核心工具，跳过外围检查。',
        plan: base('fastest', 'read-only', [
          { id: 's1', tool: 'workspace.overview', label: '读取工作区' },
        ]),
      },
      {
        key: 'thorough',
        label: '完整',
        rationale: '按依赖顺序执行全部受控工具。',
        plan: base('thorough', 'guarded', [
          { id: 's1', tool: 'workspace.overview', label: '读取工作区' },
          { id: 's2', tool: 'training.gpu', label: 'GPU 训练' },
        ]),
      },
      {
        key: 'read-only',
        label: '只读',
        rationale: '不触发任何写操作，仅查看。',
        plan: base('read-only', 'read-only', [
          { id: 's1', tool: 'workspace.overview', label: '读取工作区' },
        ]),
      },
    ];
  }

  it('offers plan variants and executes only the operator-chosen one (Bakusevych #2)', async () => {
    const executeBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/sim2real/dsh/chat')) return jsonResponse({ ok: false }, 503);
      if (url.endsWith('/api/sim2real/agent/plan'))
        return jsonResponse({ plan: planVariants()[1].plan, variants: planVariants() });
      if (url.endsWith('/api/sim2real/agent/execute')) {
        executeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          run: {
            id: 'run-variant-1',
            goal: '完成仿真、GPU训练并检查 X5',
            status: 'completed',
            steps: [{ id: 's1', label: '读取工作区', status: 'completed', detail: 'ok' }],
            evidence: [],
          },
        });
      }
      if (url.includes('/api/sim2real/agent/runs/'))
        return jsonResponse({
          run: {
            id: 'run-variant-1',
            goal: '完成仿真、GPU训练并检查 X5',
            status: 'completed',
            steps: [{ id: 's1', label: '读取工作区', status: 'completed', detail: 'ok' }],
            evidence: [],
          },
        });
      return jsonResponse({ ok: true });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    input.value = '完成仿真、GPU训练并检查 X5';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);

    // The picker renders before any execute call: nothing has been submitted.
    const picker = window.document.querySelector('.agent-plan-picker');
    expect(picker, 'multi-variant plans must pause for an explicit choice').toBeTruthy();
    expect(executeBodies).toHaveLength(0);
    const options = [...window.document.querySelectorAll<HTMLButtonElement>('.agent-plan-option')];
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain('最快');
    expect(options[0]?.textContent).toContain('1 步');
    // The thorough variant is marked as the recommended default.
    expect(options[1]?.classList.contains('is-default')).toBe(true);
    expect(window.document.querySelector('.agent-plan-cancel')?.textContent).toContain('先不执行');

    options[0]?.click();
    await wait(50);

    // Exactly one execute, carrying the fastest plan — not the default one.
    expect(executeBodies).toHaveLength(1);
    const sent = (executeBodies[0]?.plan as { id?: string; safety?: string }) ?? {};
    expect(sent.id).toBe('plan-fastest');
    // Choosing an answer locks every picker button so the choice is final.
    expect(
      window.document.querySelectorAll<HTMLButtonElement>('.agent-plan-picker button[disabled]'),
    ).toHaveLength(4);
    expect(window.document.querySelector('#agent-plan-card')?.textContent).toContain('读取工作区');
  });

  it('cancels the plan choice without issuing any execute request', async () => {
    const executeCalls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/sim2real/dsh/chat')) return jsonResponse({ ok: false }, 503);
      if (url.endsWith('/api/sim2real/agent/plan'))
        return jsonResponse({ plan: planVariants()[1].plan, variants: planVariants() });
      if (url.endsWith('/api/sim2real/agent/execute')) {
        executeCalls.push(url);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    input.value = '完成仿真、GPU训练并检查 X5';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);

    window.document.querySelector<HTMLButtonElement>('.agent-plan-cancel')?.click();
    await wait(30);

    expect(executeCalls).toHaveLength(0);
    const messages = window.document.querySelector('#agent-chat-messages');
    expect(messages?.textContent).toContain('已取消');
    const picker = window.document.querySelector('.agent-plan-picker');
    expect(picker?.textContent).toContain('已取消：未执行任何步骤。');
  });

  it('requires a separate approval before a resource-affecting plan executes', async () => {
    const executeBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/sim2real/dsh/chat')) return jsonResponse({ ok: false }, 503);
      if (url.endsWith('/api/sim2real/agent/plan')) {
        const plan = planVariants()[1].plan;
        return jsonResponse({ ok: true, plan, variants: [planVariants()[1]] });
      }
      if (url.endsWith('/api/sim2real/agent/execute')) {
        executeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          run: {
            id: 'run-approval-1',
            goal: '完成仿真、GPU训练并检查 X5',
            status: 'completed',
            steps: [{ id: 's2', label: 'GPU 训练', status: 'completed' }],
            evidence: [],
          },
        });
      }
      if (url.includes('/api/sim2real/agent/runs/')) {
        return jsonResponse({
          run: {
            id: 'run-approval-1',
            goal: '完成仿真、GPU训练并检查 X5',
            status: 'completed',
            steps: [{ id: 's2', label: 'GPU 训练', status: 'completed' }],
            evidence: [],
          },
        });
      }
      return jsonResponse({ ok: true });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    input.value = '完成 GPU 训练';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    expect(window.document.querySelector('.agent-approval-card')?.textContent).toContain(
      '明确批准',
    );
    expect(executeBodies).toHaveLength(0);
    window.document
      .querySelector<HTMLButtonElement>('.agent-approval-card .button-primary')
      ?.click();
    await wait(60);
    expect(executeBodies).toHaveLength(1);
    expect(executeBodies[0]?.approved).toBe(true);
  });
});

describe('Agent session rail (G12: remember recent context)', () => {
  const SESSIONS_KEY = 'rdk-sim2real-agent-sessions-v1';

  /** A completed run that exercises every restorable part of a task card. */
  function completedRun() {
    return {
      id: 'run-1',
      goal: '检查 X5 板卡状态',
      status: 'completed',
      steps: [
        { id: 'step-1', label: '读取板卡状态', status: 'completed', detail: '在线' },
        { id: 'step-2', label: '检查磁盘用量', status: 'completed', detail: '42%' },
      ],
      evidence: [
        { label: '运行记录', value: 'run-1', href: '/sim2real/runs/run-1' },
        { label: '板端样本', value: '480 条' },
      ],
    };
  }

  function bootWithRun() {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/api/sim2real/dsh/chat')) return jsonResponse({ ok: false }, 503);
      if (url.endsWith('/api/sim2real/agent/plan')) {
        return jsonResponse({
          plan: {
            goal: '检查 X5 板卡状态',
            safety: 'read-only',
            steps: [
              { id: 'step-1', tool: 'board.status', label: '读取板卡状态' },
              { id: 'step-2', tool: 'board.disk', label: '检查磁盘用量' },
            ],
          },
        });
      }
      if (url.endsWith('/api/sim2real/agent/execute')) return jsonResponse({ run: completedRun() });
      if (url.includes('/api/sim2real/agent/runs/')) return jsonResponse({ run: completedRun() });
      return jsonResponse({ ok: true, ...(body || {}) });
    });
    const window = boot(fetchImpl);
    const input = window.document.querySelector<HTMLInputElement>('#agent-chat-input');
    const form = window.document.querySelector<HTMLFormElement>('#agent-chat-form');
    if (!input || !form) throw new Error('agent chat fixture is incomplete');
    return { window, input, form };
  }

  function bootEmpty() {
    const dom = new JSDOM(shell(), {
      url: 'http://127.0.0.1:3000/sim2real/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    openWindows.push(dom.window);
    Object.assign(dom.window, {
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      Headers,
      Response,
      ApiError: class extends Error {},
      request: async () => ({}),
    });
    dom.window.eval(agentSource);
    return dom.window;
  }

  it('persists a session with the terminal task card and restores it after reload', async () => {
    const { window, input, form } = bootWithRun();
    input.value = '检查 X5 板卡状态';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(500);

    const stored = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) || '[]');
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBe(1);
    expect(stored[0].messages.length).toBeGreaterThan(2);
    expect(stored[0].messages[0].role).toBe('user');
    expect(stored[0].messages[0].text).toBe('检查 X5 板卡状态');
    expect(stored[0].task.status).toBe('completed');
    expect(stored[0].task.steps).toHaveLength(2);
    expect(stored[0].task.evidence[0].href).toBe('/sim2real/runs/run-1');

    // Start a second conversation so the rail gains a historical entry
    // before the reload.
    window.document.querySelector<HTMLButtonElement>('#agent-new-session')?.click();
    input.value = '再检查一次磁盘';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(500);

    // Reload: a second boot over the same localStorage restores messages and
    // renders the historical task card read-only.
    const persisted = window.localStorage.getItem(SESSIONS_KEY) || '[]';
    const dom2 = new JSDOM(shell(), {
      url: 'http://127.0.0.1:3000/sim2real/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    openWindows.push(dom2.window);
    Object.assign(dom2.window, {
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      Headers,
      Response,
      ApiError: class extends Error {},
      request: async () => ({}),
    });
    dom2.window.localStorage.setItem(SESSIONS_KEY, persisted);
    dom2.window.eval(agentSource);
    await wait(10);

    // The newest session is active; the first one appears as a historical
    // rail entry that reopens the transcript and the task card.
    const rail = [
      ...dom2.window.document.querySelectorAll<HTMLButtonElement>(
        '#agent-session-list .agent-session-item',
      ),
    ];
    expect(rail.length).toBe(2);
    const historical = rail.find((node) => !node.hasAttribute('data-static-current'));
    expect(historical?.textContent).toBe('检查 X5 板卡状态');
    historical?.click();
    const messages = dom2.window.document.querySelector('#agent-chat-messages');
    expect(messages?.textContent).toContain('检查 X5 板卡状态');
    const restored = messages?.querySelector('.agent-task-card-restored');
    expect(restored, 'historical task card must be replayed').toBeTruthy();
    expect(restored?.textContent).toContain('历史任务卡（只读回放，不能续跑）');
    expect(restored?.textContent).toContain('检查 X5 板卡状态');
    expect(restored?.textContent).toContain('读取板卡状态');
  });

  it('starts a fresh session that clears the transcript without stale cards', async () => {
    const { window, input, form } = bootWithRun();
    input.value = '检查 X5 板卡状态';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(500);
    expect(window.document.querySelector('#agent-chat-messages')?.textContent).toContain(
      '任务完成',
    );

    window.document.querySelector<HTMLButtonElement>('#agent-new-session')?.click();
    const transcript = window.document.querySelector('#agent-chat-messages');
    expect(transcript?.querySelectorAll('.agent-chat-message').length).toBe(1);
    expect(transcript?.textContent).toContain('新的对话已开始');
    expect(transcript?.querySelector('.agent-task-card-restored')).toBeNull();
  });

  it('caps stored sessions at 12 and drops the oldest overflow', async () => {
    const window = bootEmpty();
    const seed = Array.from({ length: 20 }, (_, index) => ({
      id: `sess-old-${index}`,
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      title: `旧会话 ${index}`,
      messages: [{ role: 'agent', text: 'hello' }],
      task: null,
    }));
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(seed));
    window.document.querySelector<HTMLButtonElement>('#agent-new-session')?.click();
    const stored = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) || '[]');
    expect(stored.length).toBeLessThanOrEqual(12);
  });

  it('adopts legacy single-conversation history as a session on first load', async () => {
    const dom = new JSDOM(shell(), {
      url: 'http://127.0.0.1:3000/sim2real/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    openWindows.push(dom.window);
    Object.assign(dom.window, {
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      Headers,
      Response,
      ApiError: class extends Error {},
      request: async () => ({}),
    });
    dom.window.localStorage.setItem(
      'rdk-sim2real-agent-history-v1',
      JSON.stringify([
        { role: 'user', text: '跑一轮 GPU 训练' },
        { role: 'agent', text: '收到。' },
      ]),
    );
    dom.window.eval(agentSource);
    await wait(10);

    const stored = JSON.parse(dom.window.localStorage.getItem(SESSIONS_KEY) || '[]');
    expect(stored.some((item: { adoptedLegacy?: boolean }) => item.adoptedLegacy)).toBe(true);
    expect(dom.window.document.querySelector('#agent-chat-messages')?.textContent).toContain(
      '跑一轮 GPU 训练',
    );
  });
});
