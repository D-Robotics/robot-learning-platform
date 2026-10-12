/* Dependency-free primitives shared by the standalone and Studio workbench. */
(function (root) {
  'use strict';

  const pendingButtons = new WeakMap();
  const pendingTasks = new WeakMap();
  const stateDefaults = {
    loading: { icon: '◌', title: '正在加载' },
    empty: { icon: '◇', title: '暂无内容' },
    error: { icon: '!', title: '加载失败' },
  };

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function actionButton(document, action, small) {
    const variant = action.variant === 'primary' ? 'primary' : 'ghost';
    const button = element(
      document,
      'button',
      `button button-${variant}${small ? ' button-small' : ''}`,
      action.label,
    );
    // Callers can attach data hooks and accessible names without introducing
    // event-handler attributes, inline styles, or submit/navigation behavior.
    for (const [name, value] of Object.entries(action.attributes || {})) {
      if (/^(?:aria-[a-z-]+|data-[a-z0-9-]+|id|title|name|value)$/.test(name) && value != null) {
        button.setAttribute(name, String(value));
      }
    }
    button.type = 'button';
    button.disabled = Boolean(action.disabled);
    if (typeof action.onClick === 'function') {
      button.addEventListener('click', action.onClick);
    }
    return button;
  }

  /** Create a text-safe loading, empty, or error panel. Announcing is opt-in. */
  function createStatePanel({
    state,
    title,
    description,
    actions = [],
    className = '',
    live = false,
  }) {
    if (!Object.prototype.hasOwnProperty.call(stateDefaults, state)) {
      throw new RangeError(`Unknown UI state: ${state}`);
    }
    const document = root.document;
    const panel = element(document, 'div', `ui-state ui-state-${state}`);
    for (const name of String(className).split(/\s+/).filter(Boolean)) {
      panel.classList.add(name);
    }
    if (live) {
      panel.setAttribute('role', state === 'error' ? 'alert' : 'status');
      panel.setAttribute('aria-atomic', 'true');
    }
    const icon = element(document, 'span', 'ui-state-icon', stateDefaults[state].icon);
    icon.setAttribute('aria-hidden', 'true');
    const copy = element(document, 'div', 'ui-state-copy');
    copy.append(
      element(document, 'strong', '', title ?? stateDefaults[state].title),
      element(document, 'p', '', description ?? ''),
    );
    const controls = element(document, 'div', 'ui-state-actions');
    for (const action of actions) controls.append(actionButton(document, action, false));
    panel.append(icon, copy, controls);
    return panel;
  }

  /** Keep the original nodes (including their listeners) until work finishes. */
  function setButtonPending(button, pending, { label } = {}) {
    if (!button) return button;
    if (button.tagName !== 'BUTTON') {
      throw new TypeError('setButtonPending requires a button element');
    }
    if (pending) {
      if (pendingButtons.has(button)) return button;
      pendingButtons.set(button, {
        nodes: Array.from(button.childNodes),
        disabled: button.disabled,
        busy: button.getAttribute('aria-busy'),
        pendingClass: button.classList.contains('is-pending'),
        changedLabel: label != null,
      });
      if (label != null) button.textContent = String(label);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.classList.add('is-pending');
    } else {
      const saved = pendingButtons.get(button);
      if (!saved) return button;
      if (saved.changedLabel) button.replaceChildren(...saved.nodes);
      button.disabled = saved.disabled;
      if (saved.busy == null) button.removeAttribute('aria-busy');
      else button.setAttribute('aria-busy', saved.busy);
      button.classList.toggle('is-pending', saved.pendingClass);
      pendingButtons.delete(button);
    }
    return button;
  }

  /** Coalesce duplicate submissions and restore the button on every outcome. */
  function withButtonPending(button, task, options) {
    if (pendingTasks.has(button)) return pendingTasks.get(button);
    if (typeof task !== 'function') throw new TypeError('Pending task must be a function');
    setButtonPending(button, true, options);
    // The microtask boundary also prevents synchronous re-entry before the
    // promise has been recorded for this button.
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        setButtonPending(button, false);
        pendingTasks.delete(button);
      });
    pendingTasks.set(button, promise);
    return promise;
  }

  /** A bounded, dismissible notification region that never steals focus. */
  function createToastController(region, { limit = 3 } = {}) {
    if (!region || region.nodeType !== 1) {
      throw new TypeError('A toast controller requires a region element');
    }
    const document = region.ownerDocument;
    const view = document.defaultView || root;
    const maxVisible = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 3;
    const records = [];
    const recent = new Map();
    let destroyed = false;
    if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1');

    function notify({ message, tone = 'normal', description, action, duration } = {}) {
      if (destroyed) return () => {};
      const safeTone = ['normal', 'error', 'success'].includes(tone) ? tone : 'normal';
      const key = JSON.stringify([
        safeTone,
        String(message ?? ''),
        description ?? '',
        action?.label,
      ]);
      const previous = recent.get(key);
      if (previous && view.Date.now() - previous.createdAt < 2500) return previous.dismiss;

      const toast = element(document, 'div', `toast toast-${safeTone} ui-toast`);
      toast.setAttribute('role', safeTone === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-atomic', 'true');
      const copy = element(document, 'div', 'ui-toast-copy');
      copy.append(element(document, 'strong', '', message ?? ''));
      if (description != null && description !== '') {
        copy.append(element(document, 'p', '', description));
      }
      const controls = element(document, 'div', 'ui-toast-actions');
      if (action) controls.append(actionButton(document, { ...action, variant: 'ghost' }, true));
      const close = actionButton(document, { label: '×', variant: 'ghost' }, true);
      close.classList.add('ui-toast-dismiss');
      close.setAttribute('aria-label', '关闭通知');
      controls.append(close);
      toast.append(copy, controls);

      const defaultDuration = action ? 0 : 4800;
      const timeout =
        typeof duration === 'number' && Number.isFinite(duration)
          ? Math.max(0, Math.min(duration, 2147483647))
          : defaultDuration;
      const record = {
        toast,
        close,
        createdAt: view.Date.now(),
        timer: null,
        remaining: timeout,
        startedAt: 0,
        hovered: false,
        focused: false,
        removed: false,
        dismiss,
      };

      function pause() {
        if (record.timer == null) return;
        view.clearTimeout(record.timer);
        record.timer = null;
        record.remaining = Math.max(0, record.remaining - (view.Date.now() - record.startedAt));
      }

      function resume() {
        if (
          record.removed ||
          record.hovered ||
          record.focused ||
          record.timer != null ||
          timeout === 0
        ) {
          return;
        }
        record.startedAt = view.Date.now();
        record.timer = view.setTimeout(dismiss, record.remaining);
      }

      function pointerEnter() {
        record.hovered = true;
        pause();
      }

      function pointerLeave() {
        record.hovered = false;
        resume();
      }

      function focusIn() {
        record.focused = true;
        pause();
      }

      function focusOut(event) {
        if (event.relatedTarget && toast.contains(event.relatedTarget)) return;
        record.focused = false;
        resume();
      }

      function dismiss() {
        if (record.removed) return;
        const index = records.indexOf(record);
        const hadFocus = toast.contains(document.activeElement);
        const neighbor = records[index + 1] || records[index - 1];
        record.removed = true;
        pause();
        toast.removeEventListener('pointerenter', pointerEnter);
        toast.removeEventListener('pointerleave', pointerLeave);
        toast.removeEventListener('focusin', focusIn);
        toast.removeEventListener('focusout', focusOut);
        close.removeEventListener('click', dismiss);
        if (index !== -1) records.splice(index, 1);
        if (recent.get(key) === record) recent.delete(key);
        toast.remove();
        if (hadFocus) (neighbor?.close || region).focus({ preventScroll: true });
      }

      toast.addEventListener('pointerenter', pointerEnter);
      toast.addEventListener('pointerleave', pointerLeave);
      toast.addEventListener('focusin', focusIn);
      toast.addEventListener('focusout', focusOut);
      close.addEventListener('click', dismiss);
      records.push(record);
      recent.set(key, record);
      region.append(toast);
      resume();
      while (records.length > maxVisible) {
        // Keep the toast a keyboard user is reading or operating. If necessary
        // the newest toast yields its slot rather than removing that control.
        const oldestUnfocused = records.find(
          (item) => !item.toast.contains(document.activeElement),
        );
        if (!oldestUnfocused) break;
        oldestUnfocused.dismiss();
      }
      return dismiss;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const record of records.slice()) record.dismiss();
      recent.clear();
    }

    return Object.freeze({ notify, destroy });
  }

  root.SimUI = Object.freeze({
    createStatePanel,
    setButtonPending,
    withButtonPending,
    createToastController,
  });
})(globalThis);
