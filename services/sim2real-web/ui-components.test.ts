import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('./public/ui-components.js', import.meta.url), 'utf8');

type Action = {
  label: string;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  attributes?: Record<string, string>;
};
type ToastProps = {
  message: string;
  tone?: 'normal' | 'error' | 'success';
  description?: string;
  action?: Action;
  duration?: number;
};
type ToastController = { notify: (props: ToastProps) => () => void; destroy: () => void };
type SimUI = {
  createStatePanel: (props: {
    state: 'loading' | 'empty' | 'error';
    title?: string;
    description?: string;
    actions?: Action[];
    className?: string;
    live?: boolean;
  }) => HTMLElement;
  setButtonPending: (
    button: HTMLButtonElement,
    pending: boolean,
    options?: { label?: string },
  ) => HTMLButtonElement;
  withButtonPending: <T>(
    button: HTMLButtonElement,
    task: () => Promise<T> | T,
    options?: { label?: string },
  ) => Promise<T>;
  createToastController: (region: HTMLElement, options?: { limit?: number }) => ToastController;
};

let dom: JSDOM;
let ui: SimUI;
let document: Document;
let region: HTMLElement;
let controller: ToastController;

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM(
    '<!doctype html><body><button id="outside">外部</button><div id="toasts"></div>',
    {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    },
  );
  // jsdom owns a separate realm; share the fake clock used by its timer calls.
  dom.window.Date = Date;
  dom.window.eval(source);
  ui = (dom.window as unknown as { SimUI: SimUI }).SimUI;
  document = dom.window.document;
  region = document.getElementById('toasts')!;
  controller = ui.createToastController(region);
  vi.advanceTimersByTime(0);
});

afterEach(() => {
  controller.destroy();
  dom.window.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function dismissButton(index = 0) {
  return region.querySelectorAll<HTMLButtonElement>('.ui-toast-dismiss')[index]!;
}

function pointer(type: 'pointerenter' | 'pointerleave', index = 0) {
  region.children[index]!.dispatchEvent(new dom.window.Event(type));
}

describe('state panels', () => {
  it('renders text safely and exposes declarative actions without submit or inline handlers', () => {
    const onClick = vi.fn();
    const panel = ui.createStatePanel({
      state: 'empty',
      title: '<img src=x onerror=alert(1)>',
      description: '<script>window.injected = true</script>',
      className: 'wide custom-panel',
      actions: [
        {
          label: '<b>创建</b>',
          variant: 'primary',
          onClick,
          attributes: {
            'data-action': 'create',
            'aria-label': '创建项目',
            onclick: 'alert(1)',
            type: 'submit',
          },
        },
      ],
    });
    const button = panel.querySelector('button')!;
    expect(panel.className).toBe('ui-state ui-state-empty wide custom-panel');
    expect(panel.querySelector('.ui-state-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(panel.querySelector('strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('p')?.textContent).toBe('<script>window.injected = true</script>');
    expect(panel.querySelector('img, script, b')).toBeNull();
    expect(button.className).toBe('button button-primary');
    expect(button.type).toBe('button');
    expect(button.dataset.action).toBe('create');
    expect(button.getAttribute('aria-label')).toBe('创建项目');
    expect(button.hasAttribute('onclick')).toBe(false);
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps repeated background rendering quiet and announces explicit live states', () => {
    expect(ui.createStatePanel({ state: 'loading' }).hasAttribute('role')).toBe(false);
    expect(ui.createStatePanel({ state: 'loading', live: true }).getAttribute('role')).toBe(
      'status',
    );
    const error = ui.createStatePanel({ state: 'error', live: true });
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.getAttribute('aria-atomic')).toBe('true');
    expect(error.querySelector('strong')?.textContent).toBe('加载失败');
  });

  it('honors disabled actions and renders a stable empty description slot', () => {
    const onClick = vi.fn();
    const panel = ui.createStatePanel({
      state: 'empty',
      actions: [{ label: '创建', onClick, disabled: true }],
    });
    panel.querySelector('button')!.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(panel.querySelector('p')?.textContent).toBe('');
    expect(panel.querySelector('button')?.className).toBe('button button-ghost');
  });
});

describe('pending buttons', () => {
  it('preserves child nodes and listeners while restoring prior disabled and busy state', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    const onClick = vi.fn();
    icon.textContent = '图标';
    icon.addEventListener('click', onClick);
    button.append(icon, ' 提交');
    button.disabled = true;
    button.setAttribute('aria-busy', 'false');
    ui.setButtonPending(button, true, { label: '<b>提交中</b>' });
    ui.setButtonPending(button, true, { label: '重复调用' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.classList.contains('is-pending')).toBe(true);
    expect(button.textContent).toBe('<b>提交中</b>');
    expect(button.querySelector('b')).toBeNull();
    ui.setButtonPending(button, false);
    expect(button.firstChild).toBe(icon);
    expect(button.textContent).toBe('图标 提交');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.classList.contains('is-pending')).toBe(false);
    icon.dispatchEvent(new dom.window.Event('click'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('leaves nodes untouched by default and removes only the attributes it introduced', () => {
    const button = document.createElement('button');
    button.append(document.createTextNode('保存'));
    const text = button.firstChild;
    ui.setButtonPending(button, true);
    expect(button.firstChild).toBe(text);
    ui.setButtonPending(button, false);
    ui.setButtonPending(button, false);
    expect(button.firstChild).toBe(text);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('executes one task per button and propagates the result to repeated callers', async () => {
    const button = document.createElement('button');
    button.textContent = '保存';
    let finish!: (value: string) => void;
    const task = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const first = ui.withButtonPending(button, task, { label: '保存中' });
    const second = ui.withButtonPending(button, task);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    finish('saved');
    await expect(first).resolves.toBe('saved');
    expect(button.textContent).toBe('保存');
    expect(button.disabled).toBe(false);
    await expect(ui.withButtonPending(button, () => 'next')).resolves.toBe('next');
  });

  it('restores the original button and allows retry after a synchronous task error', async () => {
    const button = document.createElement('button');
    button.textContent = '发送';
    await expect(
      ui.withButtonPending(
        button,
        () => {
          throw new Error('Network unavailable');
        },
        { label: '发送中' },
      ),
    ).rejects.toThrow('Network unavailable');
    expect(button.textContent).toBe('发送');
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    await expect(ui.withButtonPending(button, async () => 'retry')).resolves.toBe('retry');
  });
});

describe('toast notifications', () => {
  it('renders safe text, assertive errors, polite success, and accessible dismiss controls', () => {
    const dismiss = controller.notify({
      message: '<img src=x onerror=alert(1)>',
      description: '<script>bad()</script>',
      tone: 'error',
    });
    const toast = region.firstElementChild!;
    expect(toast.className).toBe('toast toast-error ui-toast');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.getAttribute('aria-atomic')).toBe('true');
    expect(toast.querySelector('strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(toast.querySelector('p')?.textContent).toBe('<script>bad()</script>');
    expect(toast.querySelector('img, script')).toBeNull();
    expect(dismissButton().getAttribute('aria-label')).toBe('关闭通知');
    expect(dismissButton().type).toBe('button');
    dismiss();
    dismiss();
    expect(region.children).toHaveLength(0);
    controller.notify({ message: '保存成功', tone: 'success' });
    expect(region.firstElementChild?.getAttribute('role')).toBe('status');
  });

  it('does not steal focus and expires after the default duration', () => {
    const outside = document.getElementById('outside')!;
    outside.focus();
    controller.notify({ message: '已保存' });
    expect(document.activeElement).toBe(outside);
    vi.advanceTimersByTime(4799);
    expect(region.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(region.children).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
  });

  it('retains action notifications until dismissed and permits an explicit duration', () => {
    const onClick = vi.fn();
    controller.notify({ message: '请求失败', action: { label: '重试', onClick } });
    region.querySelector<HTMLButtonElement>('.ui-toast-actions button')!.click();
    expect(onClick).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    expect(region.children).toHaveLength(1);
    dismissButton().click();
    controller.notify({ message: '另一个操作', action: { label: '打开' }, duration: 300 });
    vi.advanceTimersByTime(300);
    expect(region.children).toHaveLength(0);
  });

  it('pauses the remaining countdown on hover instead of resetting its duration', () => {
    controller.notify({ message: '内容较长' });
    vi.advanceTimersByTime(1000);
    pointer('pointerenter');
    vi.advanceTimersByTime(10000);
    expect(region.children).toHaveLength(1);
    pointer('pointerleave');
    vi.advanceTimersByTime(3799);
    expect(region.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(region.children).toHaveLength(0);
  });

  it('pauses during keyboard focus and resumes only after both focus and hover leave', () => {
    controller.notify({ message: '键盘可读' });
    vi.advanceTimersByTime(1000);
    dismissButton().focus();
    pointer('pointerenter');
    vi.advanceTimersByTime(10000);
    pointer('pointerleave');
    vi.advanceTimersByTime(10000);
    expect(region.children).toHaveLength(1);
    document.getElementById('outside')!.focus();
    vi.advanceTimersByTime(3800);
    expect(region.children).toHaveLength(0);
  });

  it('does not resume when focus moves between controls in the same toast', () => {
    controller.notify({ message: '操作提示', action: { label: '操作' }, duration: 500 });
    const action = region.querySelector<HTMLButtonElement>('.ui-toast-actions button')!;
    action.focus();
    dismissButton().focus();
    vi.advanceTimersByTime(5000);
    expect(region.children).toHaveLength(1);
    document.getElementById('outside')!.focus();
    vi.advanceTimersByTime(500);
    expect(region.children).toHaveLength(0);
  });

  it('bounds notifications while protecting a toast that contains keyboard focus', () => {
    controller.notify({ message: '第一条', duration: 0 });
    dismissButton().focus();
    const focused = document.activeElement;
    controller.notify({ message: '第二条', duration: 0 });
    controller.notify({ message: '第三条', duration: 0 });
    controller.notify({ message: '第四条', duration: 0 });
    expect(region.children).toHaveLength(3);
    expect(region.textContent).toContain('第一条');
    expect(region.textContent).not.toContain('第二条');
    expect(document.activeElement).toBe(focused);
  });

  it('moves focus to a neighboring dismiss button, then the empty notification region', () => {
    controller.notify({ message: '第一条', duration: 0 });
    controller.notify({ message: '第二条', duration: 0 });
    const next = dismissButton(1);
    dismissButton().focus();
    dismissButton().click();
    expect(document.activeElement).toBe(next);
    next.click();
    expect(document.activeElement).toBe(region);
    expect(region.getAttribute('tabindex')).toBe('-1');
  });

  it('deduplicates an active notification for 2.5 seconds and permits later or changed messages', () => {
    const first = controller.notify({ message: '重复消息', duration: 0 });
    vi.advanceTimersByTime(2499);
    const repeated = controller.notify({ message: '重复消息', duration: 0 });
    expect(repeated).toBe(first);
    expect(region.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    controller.notify({ message: '重复消息', duration: 0 });
    expect(region.children).toHaveLength(2);
    controller.notify({ message: '重复消息', description: '额外详情', duration: 0 });
    expect(region.children).toHaveLength(3);
  });

  it('permits immediate reappearance after dismissal and cleans up timers on destroy', () => {
    controller.notify({ message: '消息' })();
    controller.notify({ message: '消息' });
    expect(region.children).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    dismissButton().focus();
    controller.destroy();
    controller.destroy();
    expect(document.activeElement).toBe(region);
    expect(region.children).toHaveLength(0);
    // jsdom focus queues selectionchange with setImmediate; flush that task
    // before checking that the controller has canceled its longer timers.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.notify({ message: '销毁后的消息' })();
    expect(region.children).toHaveLength(0);
  });

  it('supports a single-slot region without removing its focused notification', () => {
    controller.destroy();
    controller = ui.createToastController(region, { limit: 1 });
    controller.notify({ message: '当前操作', duration: 0 });
    dismissButton().focus();
    const focused = document.activeElement;
    controller.notify({ message: '新消息', duration: 0 });
    expect(region.children).toHaveLength(1);
    expect(region.textContent).toContain('当前操作');
    expect(document.activeElement).toBe(focused);
  });
});
