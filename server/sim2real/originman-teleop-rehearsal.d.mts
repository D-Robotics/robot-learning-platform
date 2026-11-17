export class OriginmanTeleopRehearsal {
  constructor();
  close(reason?: string): void;
  handle(body: unknown): [status: number, payload: Record<string, unknown>];
}
