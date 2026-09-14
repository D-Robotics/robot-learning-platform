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
        <div id="agent-session-list"><button class="agent-session-item" type="button">当前对话</button></div>
      </aside>
      <div id="agent-chat-messages"></div>
      <div id="agent-plan-card"></div>
      <div id="agent-evidence"></div>
      <div id="agent-event-log"></div>
      <form id="agent-chat-form">
        <input id="agent-chat-input" />
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
});
