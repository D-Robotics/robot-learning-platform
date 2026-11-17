import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Device } from '../../shared/types.js';

const HOST_PATH = '/api/plugins/rdk-robot-learning-platform/desktop';
const MAX_BYTES = 1024 * 1024;
export function isStudioDesktopDeviceId(value: string | undefined): boolean {
  return typeof value === 'string' && /^studio-[a-f0-9]{24}$/.test(value);
}
export type StudioDesktopDevice = Device & {
  source: 'studio-desktop';
  bridgeOwnerKey: 'local:default';
};
export type StudioDesktopCatalog = {
  state: 'unconfigured' | 'awaiting-host' | 'ready' | 'unavailable';
  devices: StudioDesktopDevice[];
  code?:
    | 'STUDIO_DESKTOP_AUTH_REQUIRED'
    | 'STUDIO_DESKTOP_UPGRADE_REQUIRED'
    | 'STUDIO_DESKTOP_UNAVAILABLE';
};
type BridgeOptions = {
  origin: () => string | undefined;
  allowed: () => boolean;
  fetchImpl?: typeof fetch;
};
function localOrigin(raw: string | undefined): string | null {
  if (
    !raw ||
    raw.length > 512 ||
    [...raw].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
function tokenValue(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;
}
function safeText(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    ? value
    : null;
}
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw Error('desktop-response-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw Error('desktop-response-too-large');
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}
/** Project host transport refusals into product-owned recovery guidance only. */
function hostFailure(
  status: number,
  hostCode?: unknown,
): {
  ok: false;
  status: number;
  payload: Record<string, unknown>;
  frame?: undefined;
} {
  let error = 'SIM2REAL_STUDIO_DEVICE_BRIDGE_UNAVAILABLE';
  let message = 'Studio 设备桥暂不可用，请刷新 Studio 设备连接后重试。';
  let retryable = true;
  if (status === 409 && hostCode === 'learning-board-no-session') {
    error = 'SIM2REAL_STUDIO_SSH_SESSION_NOT_READY';
    message = 'Studio 的 SSH 会话尚未就绪，请在 Studio 刷新目标设备连接后重试，无需重新填写密码。';
  } else if (status === 413) {
    error = 'SIM2REAL_STUDIO_UPLOAD_TOO_LARGE';
    message =
      '模型上传请求过大：Studio 设备桥最多接收 2 MiB 的 JSON 上传内容（含 base64），请缩小模型后重试。';
    retryable = false;
  } else if (status === 403) {
    error = 'SIM2REAL_STUDIO_PLUGIN_NOT_CONNECTED';
    message = '本地插件连接已失效，请在 Studio 启用学习平台插件并重新连接后重试。';
  } else if (status === 404) {
    error = 'SIM2REAL_STUDIO_DEVICE_NOT_FOUND';
    message = 'Studio 中未找到目标设备，请刷新设备列表并重新选择目标设备。';
    retryable = false;
  } else if (status === 502) {
    error = 'SIM2REAL_STUDIO_BOARD_AGENT_UNREACHABLE';
    message = '无法连接板端 BoardAgent，请在 Studio 检查目标设备连接与板端服务后重试。';
  } else if (status === 504) {
    error = 'SIM2REAL_STUDIO_BOARD_AGENT_TIMEOUT';
    message = '板端 BoardAgent 响应超时，请检查目标设备和服务状态后重试。';
  }
  return { ok: false, status, payload: { ok: false, error, message, retryable } };
}
/** Desktop-only memory lease. Every use is reauthorized by Studio; no credential is stored on disk. */
export class StudioDesktopBridge {
  private readonly scope = new AsyncLocalStorage<{ token?: string; supplied: boolean }>();
  private verified: { origin: string; token: string } | undefined;
  private failure: { origin: string; code: StudioDesktopCatalog['code'] } | undefined;
  constructor(private readonly options: BridgeOptions) {}
  runWithToken<T>(value: unknown, callback: () => T): T {
    // An explicitly malformed header must not inherit another request's capability.
    return this.scope.run({ token: tokenValue(value), supplied: value !== undefined }, callback);
  }
  configured(): boolean {
    return Boolean(this.context());
  }
  /** A configured embedding origin alone grants no device access. */
  hasVerifiedLease(): boolean {
    const context = this.context();
    return Boolean(
      context?.token &&
      this.verified?.origin === context.origin &&
      this.verified.token === context.token,
    );
  }
  private context() {
    if (!this.options.allowed()) {
      this.verified = undefined;
      this.failure = undefined;
      return null;
    }
    const origin = localOrigin(this.options.origin());
    if (!origin) {
      this.verified = undefined;
      this.failure = undefined;
      return null;
    }
    const scope = this.scope.getStore();
    const token = scope?.supplied
      ? scope.token
      : this.verified?.origin === origin
        ? this.verified.token
        : undefined;
    return { origin, token };
  }
  async catalog(): Promise<StudioDesktopCatalog> {
    const context = this.context();
    if (!context) return { state: 'unconfigured', devices: [] };
    if (!context.token) {
      if (!this.scope.getStore()?.supplied && this.failure?.origin === context.origin)
        return { state: 'unavailable', devices: [], code: this.failure.code };
      return { state: 'awaiting-host', devices: [], code: 'STUDIO_DESKTOP_AUTH_REQUIRED' };
    }
    const { origin, token } = context;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(origin + HOST_PATH + '/devices', {
        headers: {
          accept: 'application/json',
          'x-rdk-client': 'electron',
          'x-rdk-desktop-host-token': token,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (this.verified?.token === token) this.verified = undefined;
        this.failure = {
          origin,
          code:
            response.status === 404
              ? 'STUDIO_DESKTOP_UPGRADE_REQUIRED'
              : response.status === 401 || response.status === 403
                ? 'STUDIO_DESKTOP_AUTH_REQUIRED'
                : 'STUDIO_DESKTOP_UNAVAILABLE',
        };
        return {
          state: 'unavailable',
          devices: [],
          code:
            response.status === 404
              ? 'STUDIO_DESKTOP_UPGRADE_REQUIRED'
              : response.status === 401 || response.status === 403
                ? 'STUDIO_DESKTOP_AUTH_REQUIRED'
                : 'STUDIO_DESKTOP_UNAVAILABLE',
        };
      }
      const payload: unknown = JSON.parse(await boundedText(response));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw Error('desktop-invalid-catalog');
      const data = payload as Record<string, unknown>;
      if (data.ok !== true || !Array.isArray(data.devices) || data.devices.length > 500)
        throw Error('desktop-invalid-catalog');
      const seen = new Set<string>();
      const devices = data.devices.map((value): StudioDesktopDevice => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw Error('desktop-invalid-device');
        const row = value as Record<string, unknown>;
        const id = safeText(row.id, 128),
          host = safeText(row.host, 255),
          user = safeText(row.username, 160);
        const name = safeText(row.name, 120);
        if (
          !id ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
          seen.has(id) ||
          !host ||
          !user ||
          !Number.isInteger(row.port) ||
          Number(row.port) < 1 ||
          Number(row.port) > 65535 ||
          !['connected', 'disconnected', 'offline'].includes(String(row.status))
        )
          throw Error('desktop-invalid-device');
        seen.add(id);
        return {
          id: `studio-${createHash('sha256')
            .update(origin + '\0' + id)
            .digest('hex')
            .slice(0, 24)}`,
          name: name ?? id,
          host,
          username: user,
          port: Number(row.port),
          status: row.status === 'connected' ? 'connected' : 'disconnected',
          lastCheckedAt: new Date().toISOString(),
          connectionMode: 'bridge',
          bridgeId: 'studio-desktop',
          bridgeDeviceId: id,
          bridgeTransport: 'ssh',
          bridgeOwnerKey: 'local:default',
          source: 'studio-desktop',
          ...(safeText(row.platform, 80) ? { boardPlatform: String(row.platform) } : {}),
          ...(safeText(row.model, 120) ? { boardModel: String(row.model) } : {}),
        };
      });
      if (!this.options.allowed() || localOrigin(this.options.origin()) !== origin)
        return { state: 'unconfigured', devices: [] };
      this.verified = { origin, token };
      this.failure = undefined;
      return { state: 'ready', devices };
    } catch {
      // No raw transport error (which could contain credentials) crosses this boundary.
      if (this.verified?.token === token) this.verified = undefined;
      return { state: 'unavailable', devices: [], code: 'STUDIO_DESKTOP_UNAVAILABLE' };
    }
  }
  private async exchange(
    deviceId: string,
    pathname: string,
    options: {
      method?: 'GET' | 'POST';
      body?: string;
      agentToken?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    if (!isStudioDesktopDeviceId(deviceId)) return null;
    const catalog = await this.catalog();
    const device = catalog.devices.find((row) => row.id === deviceId && row.status === 'connected');
    const context = this.context();
    if (
      !device ||
      !context?.token ||
      !this.allowedPath(pathname, options.method ?? 'GET') ||
      (options.method !== 'POST' && options.body) ||
      (options.agentToken && !tokenValue(options.agentToken))
    )
      return null;
    if (
      options.body &&
      Buffer.byteLength(options.body) >
        (pathname === '/v1/station/policy/upload' ? 2 * MAX_BYTES : MAX_BYTES)
    )
      return pathname === '/v1/station/policy/upload' ? hostFailure(413) : null;
    const { origin, token } = context;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        origin + HOST_PATH + '/board-agent',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-rdk-client': 'electron',
            'x-rdk-desktop-host-token': token,
          },
          body: JSON.stringify({
            deviceId: device.bridgeDeviceId,
            method: options.method ?? 'GET',
            path: pathname,
            ...(options.body ? { body: options.body } : {}),
            ...(options.agentToken ? { agentToken: options.agentToken } : {}),
          }),
          redirect: 'error',
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.min(15000, Math.max(500, options.timeoutMs ?? 5000))),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
      if (!response.ok) {
        let hostCode: unknown;
        try {
          const failure: unknown = JSON.parse(await boundedText(response));
          if (failure && typeof failure === 'object' && !Array.isArray(failure))
            hostCode = (failure as Record<string, unknown>).error;
        } catch {
          // The HTTP status remains useful when a host diagnostic is malformed or oversized.
        }
        return hostFailure(response.status, hostCode);
      }
      const envelope = JSON.parse(await boundedText(response)) as Record<string, unknown>;
      if (
        pathname === '/v1/station/camera.snapshot' &&
        envelope.ok === true &&
        envelope.status === 200 &&
        envelope.contentType === 'image/jpeg' &&
        typeof envelope.bodyBase64 === 'string'
      ) {
        const encoded = envelope.bodyBase64;
        if (
          encoded.length > 4 * Math.ceil((180 * 1024) / 3) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
        )
          return null;
        const frame = Buffer.from(encoded, 'base64');
        if (
          frame.toString('base64') !== encoded ||
          frame.length < 4 ||
          frame.length > 180 * 1024 ||
          frame[0] !== 255 ||
          frame[1] !== 216 ||
          frame.at(-2) !== 255 ||
          frame.at(-1) !== 217
        )
          return null;
        return { frame };
      }
      if (
        envelope.ok !== true ||
        !Number.isInteger(envelope.status) ||
        Number(envelope.status) < 200 ||
        Number(envelope.status) > 599 ||
        typeof envelope.body !== 'string' ||
        Buffer.byteLength(envelope.body) > MAX_BYTES ||
        !/^application\/json(?:;|$)/i.test(String(envelope.contentType))
      )
        return null;
      const payload: unknown = JSON.parse(envelope.body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return {
        ok: Number(envelope.status) >= 200 && Number(envelope.status) < 300,
        status: Number(envelope.status),
        payload: payload as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
  async agent(
    deviceId: string,
    pathname: string,
    options: {
      method?: 'GET' | 'POST';
      body?: string;
      agentToken?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const result = await this.exchange(deviceId, pathname, options);
    return result?.payload
      ? { ok: result.ok, status: result.status, payload: result.payload }
      : null;
  }
  async snapshot(
    deviceId: string,
    options: { agentToken?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Uint8Array | null> {
    const result = await this.exchange(deviceId, '/v1/station/camera.snapshot', options);
    return result?.frame ?? null;
  }
  private allowedPath(pathname: string, method: string): boolean {
    const get = [
      '/healthz',
      '/v1/onboarding/preflight',
      '/v1/station/status',
      '/v1/station/camera.snapshot',
      '/v1/station/policy',
      '/v1/station/policy/files',
      '/v1/station/drive',
      '/v1/config',
    ];
    const post = [
      '/v1/station/commands',
      '/v1/station/policy/upload',
      '/v1/station/policy-infer',
      '/v1/station/policy/load',
      '/v1/station/policy/start',
      '/v1/station/policy/reset',
      '/v1/station/policy/stop',
      '/v1/station/drive',
      '/v1/station/drive/stop',
    ];
    return method === 'GET'
      ? get.includes(pathname)
      : method === 'POST' &&
          (post.includes(pathname) ||
            /^\/v1\/devices\/[A-Za-z0-9_-]{1,128}\/commands$/.test(pathname));
  }
}

let standaloneAllowed = () => false;
export function setStudioDesktopBridgeGate(gate: () => boolean) {
  standaloneAllowed = gate;
}
export const studioDesktopBridge = new StudioDesktopBridge({
  origin: () => process.env.RDK_SIM2REAL_STUDIO_DESKTOP_ORIGIN,
  allowed: () =>
    standaloneAllowed() &&
    process.env.RDK_SIM2REAL_DEPLOYMENT === 'local' &&
    ['127.0.0.1', 'localhost', '::1'].includes(process.env.RDK_SIM2REAL_HOST ?? '127.0.0.1'),
});
