(function (root) {
  'use strict';

  function create({ request, onStatus, onLost }) {
    const intervalMs = 90;
    let endpoint = null;
    let press = null;
    let modeVersion = 0;
    let pendingStop = Promise.resolve();

    async function send(path, operation, fields = {}) {
      const result = await request(path, {
        method: 'POST',
        body: JSON.stringify({ operation, ...fields }),
        keepalive: operation === 'stop',
        signal: AbortSignal.timeout(500),
      });
      if (result?.ok !== true || result?.dryRun !== true) throw Error('联动演练接口不可用');
      return result;
    }

    function stop() {
      const previous = press;
      press = null;
      if (!previous) return pendingStop;
      clearTimeout(previous.timer);
      if (previous.lease) {
        pendingStop = send(previous.path, 'stop', { lease: previous.lease }).catch(() => {});
      }
      return pendingStop;
    }

    function disable() {
      ++modeVersion;
      endpoint = null;
      return stop();
    }

    async function enablePath(path) {
      const stopped = disable();
      const version = modeVersion;
      await stopped;
      if (version !== modeVersion) return false;
      try {
        await send(path, 'status');
        if (version !== modeVersion) return false;
        endpoint = path;
        onStatus('联动演练已开启 · 真机执行器关闭');
        return true;
      } catch {
        if (version === modeVersion) onStatus('联动演练不可用，请检查指定设备和连接。');
        return false;
      }
    }

    function enable(deviceId) {
      // The generic Station API rewrites the selected device. Use the Workshop path.
      return enablePath('/sim2real/workshops/originman/teleop?deviceId=' + encodeURIComponent(deviceId));
    }

    function lost(active) {
      if (press !== active) return;
      void stop();
      onStatus('联动中断 · 重新按键才能发送新的动作。');
      onLost();
    }

    function schedule(active) {
      if (press !== active) return;
      active.timer = setTimeout(async () => {
        try {
          await send(active.path, 'heartbeat', { lease: active.lease });
          schedule(active);
        } catch {
          lost(active);
        }
      }, intervalMs);
    }

    async function start(direction) {
      if (!endpoint) return;
      const prior = stop();
      const active = { path: endpoint, lease: null, timer: null };
      press = active;
      try {
        await prior;
        if (press !== active) return;
        const { lease } = await send(active.path, 'acquire');
        if (typeof lease !== 'string') throw Error('联动演练未返回租约');
        if (press !== active) {
          // Acquiring alone cannot move. Release late grants promptly anyway.
          await send(active.path, 'stop', { lease }).catch(() => {});
          return;
        }
        active.lease = lease;
        await send(active.path, 'press', { lease, direction });
        if (press === active) onStatus('联动演练已开启 · 真机执行器关闭');
        schedule(active);
      } catch {
        lost(active);
      }
    }

    return { enable, enablePath, disable, start, stop, isEnabled: () => endpoint !== null };
  }

  root.OriginmanTeleopLink = { create };
})(globalThis);
