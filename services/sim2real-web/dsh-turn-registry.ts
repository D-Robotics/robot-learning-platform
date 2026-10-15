export type DshTurnRecord = {
  ownerScope: string;
  publicSessionId: string;
  status: 'running' | 'complete' | 'failed';
  controller: AbortController;
  startedAt: number;
  completedAt?: number;
  reply?: Record<string, unknown>;
  failure?: { status: number; body: Record<string, unknown> };
  timeout?: ReturnType<typeof setTimeout>;
};

const RETENTION_MS = 15 * 60_000;
const REGISTRY_CAP = 64;
const EARLY_CANCEL_TTL_MS = 30_000;

/** One registry per app; client turn ids are unique only within their owner. */
export class DshTurnRegistry {
  private readonly turns = new Map<string, DshTurnRecord>();
  private readonly earlyCancels = new Map<string, number>();

  private key(turnId: string, ownerScope: string): string {
    return JSON.stringify([ownerScope, turnId]);
  }

  private timeout(record: DshTurnRecord): void {
    this.fail(record, {
      ok: false,
      error: 'DSH_TURN_TIMEOUT',
      message: '本轮等待超时，请重试。',
    });
    record.controller.abort();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.turns) {
      if (record.status === 'running' && now - record.startedAt >= RETENTION_MS) {
        this.timeout(record);
      }
      if (record.completedAt !== undefined && now - record.completedAt >= RETENTION_MS) {
        this.turns.delete(key);
      }
    }
    for (const [key, at] of this.earlyCancels) {
      if (now - at >= EARLY_CANCEL_TTL_MS) this.earlyCancels.delete(key);
    }
  }

  get(turnId: string, ownerScope: string): DshTurnRecord | undefined {
    this.sweep();
    return this.turns.get(this.key(turnId, ownerScope));
  }

  register(
    turnId: string,
    init: { ownerScope: string; publicSessionId: string; controller: AbortController },
  ): { record: DshTurnRecord } | { error: 'exists' | 'capacity' } {
    this.sweep();
    const key = this.key(turnId, init.ownerScope);
    if (this.turns.has(key)) return { error: 'exists' };
    // Evict terminal outcomes before rejecting work; an old running entry
    // must not prevent finding later completed entries or bypass the cap.
    for (const [candidateKey, record] of this.turns) {
      if (this.turns.size < REGISTRY_CAP) break;
      if (record.status !== 'running') this.turns.delete(candidateKey);
    }
    if (this.turns.size >= REGISTRY_CAP) return { error: 'capacity' };
    const record: DshTurnRecord = { ...init, status: 'running', startedAt: Date.now() };
    this.turns.set(key, record);
    record.timeout = setTimeout(() => this.timeout(record), RETENTION_MS);
    record.timeout.unref();
    if (this.earlyCancels.delete(key)) this.cancel(turnId, init.ownerScope);
    return { record };
  }

  complete(record: DshTurnRecord, reply: Record<string, unknown>): void {
    if (record.status === 'running' && Date.now() - record.startedAt >= RETENTION_MS) {
      this.timeout(record);
    }
    if (record.status !== 'running') return;
    clearTimeout(record.timeout);
    record.status = 'complete';
    record.completedAt = Date.now();
    record.reply = reply;
  }

  fail(record: DshTurnRecord, body: Record<string, unknown>, status = 502): void {
    if (record.status !== 'running') return;
    clearTimeout(record.timeout);
    record.status = 'failed';
    record.completedAt = Date.now();
    record.failure = { status, body };
  }

  cancel(turnId: string, ownerScope: string): 'cancelled' | 'complete' | 'failed' {
    this.sweep();
    const key = this.key(turnId, ownerScope);
    const record = this.turns.get(key);
    if (!record) {
      // Stop can arrive before the chat POST. Keep that intent owner-scoped
      // and bounded even if a caller sends many unknown cancellation ids.
      this.earlyCancels.delete(key);
      this.earlyCancels.set(key, Date.now());
      if (this.earlyCancels.size > REGISTRY_CAP) {
        this.earlyCancels.delete(this.earlyCancels.keys().next().value!);
      }
      return 'cancelled';
    }
    if (record.status !== 'running') return record.status;
    this.fail(record, {
      ok: false,
      error: 'DSH_TURN_CANCELLED',
      message: '本轮已按要求停止。',
    });
    record.controller.abort();
    return 'cancelled';
  }
}
