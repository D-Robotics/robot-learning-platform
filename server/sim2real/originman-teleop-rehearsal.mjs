import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ttlMs = 350;
const directions = new Set(['walk-forward', 'walk-backward', 'turn-left', 'turn-right']);

/** An isolated recorder. Its only outputs are state and counters. */
export class OriginmanTeleopRehearsal {
  #lease;
  #direction = null;
  #timer;
  #deadline = 0;
  #started = 0;
  #stopped = 0;
  #lastStop = null;

  close(reason = 'session-closed') {
    clearTimeout(this.#timer);
    if (this.#direction) this.#stopped++;
    this.#direction = null;
    this.#lease = undefined;
    this.#lastStop = reason;
  }

  #renew() {
    this.#deadline = performance.now() + ttlMs;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.close('heartbeat-timeout'), ttlMs);
    this.#timer.unref();
  }

  handle(body) {
    const accept = (fields = {}) => [200, { ok: true, dryRun: true, ...fields }];
    const reject = (status, error) => [status, { ok: false, error }];
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reject(400, 'invalid-command');
    }
    const { operation, lease, direction } = body;
    const keys = Object.keys(body).sort().join(',');
    if (operation === 'status' && keys === 'operation') {
      return accept({
        direction: this.#direction,
        started: this.#started,
        stopped: this.#stopped,
        lastStop: this.#lastStop,
      });
    }
    if (this.#lease && performance.now() >= this.#deadline) this.close('heartbeat-timeout');
    if (operation === 'acquire' && keys === 'operation') {
      if (this.#lease) return reject(409, 'lease-busy');
      this.#lease = randomBytes(24).toString('hex');
      this.#renew();
      return accept({ lease: this.#lease });
    }
    if (
      !['press', 'stop', 'heartbeat'].includes(operation) ||
      typeof lease !== 'string' ||
      !/^[a-f0-9]{48}$/.test(lease) ||
      keys !== (operation === 'press' ? 'direction,lease,operation' : 'lease,operation') ||
      (operation === 'press' && !directions.has(direction))
    )
      return reject(400, 'invalid-command');
    if (lease !== this.#lease) {
      return operation === 'stop' ? accept() : reject(409, 'lease-expired');
    }
    if (operation === 'stop') {
      this.close('operator-stop');
    } else if (operation === 'press') {
      if (this.#direction) return reject(409, 'press-already-active');
      this.#direction = direction;
      this.#started++;
      this.#renew();
    } else {
      if (!this.#direction) return reject(409, 'fresh-press-required');
      this.#renew();
    }
    return accept();
  }
}
