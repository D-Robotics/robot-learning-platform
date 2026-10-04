/**
 * Newline-delimited JSON-RPC 2.0 over stdio, per the MCP stdio transport:
 * each message is a single line of UTF-8 JSON with no embedded newlines.
 * The dispatch core is pure and unit-testable; only `serveStdio` touches
 * process streams, and everything it logs goes to stderr — stdout is
 * reserved for protocol traffic.
 *
 * Concurrency: requests are dispatched independently (a slow tool call never
 * blocks `ping` or a cancellation notice); writes stay atomic because every
 * response is emitted through a single `write` of one pre-serialized line.
 */

export type JsonRpcErrorObject = { code: number; message: string; data?: unknown };
export type JsonRpcResult = Record<string, unknown>;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcMethodContext = { signal: AbortSignal };

export type JsonRpcMethodHandler = (
  params: unknown,
  context: JsonRpcMethodContext,
) => Promise<unknown> | unknown;

export type JsonRpcDispatcher = {
  /** Handle one raw line; resolves to a serialized response line or null. */
  handleLine: (line: string) => Promise<string | null>;
};

type IncomingMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

const CANCEL_NOTIFICATION = 'notifications/cancelled';

/** Requests carrying `id: null` still get a response; only a missing id is a notification. */
function isNotification(message: IncomingMessage): boolean {
  return message.id === undefined;
}

function serialize(
  id: unknown,
  payload: { result?: JsonRpcResult; error?: JsonRpcErrorObject },
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, ...payload });
}

function errorPayload(code: number, message: string): { error: JsonRpcErrorObject } {
  return { error: { code, message } };
}

function requestId(message: IncomingMessage): string {
  return typeof message.id === 'string' || typeof message.id === 'number' ? String(message.id) : '';
}

function parseCancelTarget(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  const target = (params as Record<string, unknown>).requestId;
  return typeof target === 'string' || typeof target === 'number' ? String(target) : '';
}

export function createJsonRpcDispatcher(
  methods: Record<string, JsonRpcMethodHandler>,
): JsonRpcDispatcher {
  // Only server-initiated work that honors ctx.signal is actually
  // cancellable; aborting an already-finished controller is a no-op.
  const inFlight = new Map<string, AbortController>();

  async function dispatch(
    message: IncomingMessage,
    context: JsonRpcMethodContext,
  ): Promise<{ result?: JsonRpcResult; error?: JsonRpcErrorObject } | null> {
    const method = typeof message.method === 'string' ? message.method : '';
    if (!method)
      return { ...errorPayload(RPC_ERROR_CODES.INVALID_REQUEST, '请求缺少 method 字段。') };
    const handler = methods[method];
    if (!handler) {
      if (isNotification(message)) return null;
      return { ...errorPayload(RPC_ERROR_CODES.METHOD_NOT_FOUND, `未知方法：${method}`) };
    }
    try {
      const result = (await handler(message.params, context)) as JsonRpcResult;
      if (isNotification(message)) return null;
      return { result: result ?? {} };
    } catch (error) {
      if (isNotification(message)) return null;
      if (error instanceof RpcError) return { ...errorPayload(error.code, error.message) };
      const detail = error instanceof Error ? error.message : String(error);
      return { ...errorPayload(RPC_ERROR_CODES.INTERNAL_ERROR, detail) };
    }
  }

  async function dispatchOne(
    message: IncomingMessage,
  ): Promise<{ result?: JsonRpcResult; error?: JsonRpcErrorObject } | null> {
    if (message.method === CANCEL_NOTIFICATION) {
      const target = parseCancelTarget(message.params);
      const controller = target ? inFlight.get(target) : undefined;
      if (controller) {
        controller.abort();
        inFlight.delete(target);
      }
    }
    const controller = new AbortController();
    const id = requestId(message);
    if (id) inFlight.set(id, controller);
    try {
      return await dispatch(message, { signal: controller.signal });
    } finally {
      if (id && inFlight.get(id) === controller) inFlight.delete(id);
    }
  }

  return {
    async handleLine(line: string): Promise<string | null> {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return serialize(null, errorPayload(RPC_ERROR_CODES.PARSE_ERROR, '消息不是合法 JSON。'));
      }
      if (Array.isArray(parsed)) {
        if (!parsed.length) {
          return serialize(null, errorPayload(RPC_ERROR_CODES.INVALID_REQUEST, 'batch 不能为空。'));
        }
        const responses = await Promise.all(
          parsed.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return Promise.resolve(
                serialize(
                  null,
                  errorPayload(
                    RPC_ERROR_CODES.INVALID_REQUEST,
                    'batch 成员必须是 JSON-RPC 2.0 对象。',
                  ),
                ),
              );
            }
            return dispatchOne(item as IncomingMessage).then((outcome) => {
              if (!outcome || isNotification(item as IncomingMessage)) return null;
              return serialize((item as IncomingMessage).id, outcome);
            });
          }),
        );
        const keep = responses.filter((item): item is string => item !== null);
        return keep.length ? keep.join('\n') : null;
      }
      if (!parsed || typeof parsed !== 'object') {
        return serialize(
          null,
          errorPayload(RPC_ERROR_CODES.INVALID_REQUEST, '消息必须是 JSON-RPC 2.0 对象。'),
        );
      }
      const message = parsed as IncomingMessage;
      if (message.jsonrpc !== '2.0') {
        return serialize(
          isNotification(message) ? null : message.id,
          errorPayload(RPC_ERROR_CODES.INVALID_REQUEST, '仅支持 jsonrpc 2.0。'),
        );
      }
      const outcome = await dispatchOne(message);
      if (!outcome || isNotification(message)) return null;
      return serialize(message.id, outcome);
    },
  };
}

/** A single protocol line may not exceed 1 MiB; oversized lines get one PARSE_ERROR. */
const MAX_LINE_BYTES = 1024 * 1024;

export function serveStdio(
  dispatcher: JsonRpcDispatcher,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): { close: () => void } {
  // Bytes accumulate until a newline; only complete lines are decoded, so a
  // multi-byte character split across chunks is never torn apart.
  let buffer: Buffer = Buffer.alloc(0);
  let skippingOversized = false;
  let closed = false;

  const write = (line: string): void => {
    if (!closed) streams.output.write(`${line}\n`);
  };

  const emit = (serialized: string | null): void => {
    if (serialized) write(serialized);
  };

  const handleBufferedLine = (line: Buffer): void => {
    void dispatcher.handleLine(line.toString('utf8')).then(emit, (error: unknown) => {
      process.stderr.write(
        `[duck-lab-mcp] dispatch failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };

  const onData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;
    let newlineIndex = buffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = buffer.subarray(0, newlineIndex);
      buffer = buffer.subarray(newlineIndex + 1);
      if (skippingOversized) {
        // The oversized line already got its PARSE_ERROR; this newline just
        // ends the discard window.
        skippingOversized = false;
      } else if (line.length > MAX_LINE_BYTES) {
        write(
          serialize(
            null,
            errorPayload(RPC_ERROR_CODES.PARSE_ERROR, `单条消息超过 ${MAX_LINE_BYTES} 字节上限。`),
          ),
        );
      } else {
        handleBufferedLine(line);
      }
      newlineIndex = buffer.indexOf(0x0a);
    }
    if (!skippingOversized && buffer.length > MAX_LINE_BYTES) {
      skippingOversized = true;
      buffer = Buffer.alloc(0);
      write(
        serialize(
          null,
          errorPayload(RPC_ERROR_CODES.PARSE_ERROR, `单条消息超过 ${MAX_LINE_BYTES} 字节上限。`),
        ),
      );
    }
  };

  // Keep dispatching and flushing what already arrived after stdin closes;
  // dropping in-flight responses here would strand waiting clients.
  const onEnd = (): void => {};
  streams.input.on('data', onData);
  streams.input.on('end', onEnd);
  streams.input.on('close', onEnd);

  return {
    close: () => {
      closed = true;
      streams.input.removeListener('data', onData);
      streams.input.removeListener('end', onEnd);
      streams.input.removeListener('close', onEnd);
    },
  };
}
