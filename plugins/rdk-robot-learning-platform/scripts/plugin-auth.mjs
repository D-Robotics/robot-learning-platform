/** Host-bound Studio SSO or explicit browser consent. No password collection or profile scanning. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PluginRequestError, classifyPluginFailure, loginRequired } from './plugin-errors.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const AUTH_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
export const AUTH_TOOLS = [
  {
    name: 'rdk_auth_login',
    description:
      '未登录时开始浏览器账号授权，返回可点击的登录确认入口；在Studio中直接复用宿主当前账号。不会要求在聊天中填写密码。',
    inputSchema: {
      type: 'object',
      properties: { openBrowser: { type: 'boolean' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'rdk_auth_status',
    description: '检查插件当前认证状态并领取已完成的浏览器登录结果；不返回Cookie、密码或会话密钥。',
    inputSchema: AUTH_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'rdk_auth_logout',
    description:
      '退出插件自身连接并删除其私人浏览器会话；Studio账号退出请在Studio账号菜单操作，不会替用户退出其他应用。',
    inputSchema: AUTH_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];
export function createPluginAuth({
  env = process.env,
  fetchImpl = fetch,
  cacheDirectory = path.join(
    os.homedir(),
    '.config',
    'rdk-robot-learning-platform',
    'browser-auth',
  ),
  now = Date.now,
  openUrl = defaultOpen,
} = {}) {
  const base = new URL(
    env.RDK_SIM2REAL_MCP_BASE_URL || 'https://rdkstudio.d-robotics.cc/robotics-learning',
  );
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new PluginRequestError(
      'AUTH_CONFIGURATION_INVALID',
      '认证平台必须为HTTPS；本机测试可用HTTP回环地址。',
      { httpStatus: 400 },
    );
  const audience = base.href.replace(/\/$/, ''),
    origin = base.origin,
    native = env.RDK_STUDIO_LOGIN_BOUND === '1';
  const mode = native ? 'studio-session' : 'browser-login';
  const cacheScope = process.platform === 'win32' ? JSON.stringify([audience, root]) : audience;
  const filename = path.join(
    cacheDirectory,
    createHash('sha256').update(cacheScope).digest('hex') + '.json',
  );
  let cached = null,
    pending = null,
    disconnected = false,
    loginPromise = null,
    startPromise = null,
    pollPromise = null,
    revision = 0;
  const assertRevision = (expected) => {
    if (expected !== revision || disconnected)
      throw new PluginRequestError(
        'AUTH_OPERATION_SUPERSEDED',
        '登录操作已取消或更新，不会恢复旧会话。',
        { httpStatus: 409 },
      );
  };
  const safe = (value) =>
    value &&
    typeof value.accountId === 'string' &&
    value.accountId &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > now() &&
    typeof value.cookie === 'string' &&
    /^rdk_sso_web_session=[^\r\n\0;]+$/.test(value.cookie);
  const cacheError = () =>
    new PluginRequestError('AUTH_CACHE_INVALID', '私人认证缓存的权限、归属或格式无效。', {
      nextAction: '请检查当前系统用户和插件目录配置；不要在聊天中粘贴缓存内容。',
    });
  function check(stat, directory = false) {
    if (
      stat.isSymbolicLink() ||
      !(directory ? stat.isDirectory() : stat.isFile()) ||
      (process.platform !== 'win32' &&
        (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())))
    )
      throw cacheError();
  }
  async function read() {
    if (cached) return cached;
    try {
      check(fs.lstatSync(cacheDirectory), true);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        check(stat);
        if (stat.size > 262144) throw cacheError();
        let value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (process.platform === 'win32') {
          const { unprotectWindowsBinding } = await import('../windows-binding.mjs');
          const decoded = unprotectWindowsBinding(value.protected, root);
          value = { ...decoded, cookie: decoded.credentials?.RDK_SIM2REAL_MCP_COOKIE };
        }
        if (value.platformUrl === audience && safe(value)) cached = value;
        return cached;
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof PluginRequestError) throw error;
      throw cacheError();
    }
  }
  async function save(value, expectedRevision = revision) {
    assertRevision(expectedRevision);
    if (!safe(value))
      throw new PluginRequestError('AUTH_RESPONSE_INVALID', '平台未提供有效的登录结果。');
    fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    check(fs.lstatSync(cacheDirectory), true);
    let payload = { ...value, platformUrl: audience };
    if (process.platform === 'win32') {
      const { protectWindowsBinding } = await import('../windows-binding.mjs');
      payload = {
        protected: protectWindowsBinding({
          root,
          platformUrl: audience,
          accountId: value.accountId,
          expiresAt: value.expiresAt,
          credentials: { RDK_SIM2REAL_MCP_COOKIE: value.cookie },
        }),
      };
    }
    assertRevision(expectedRevision);
    const temp = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, filename);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    cached = value;
  }
  async function request(route, { body, headers = {} } = {}) {
    let response;
    try {
      response = await fetchImpl(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw classifyPluginFailure(error);
    }
    if (!response.ok) {
      if ([401, 410].includes(response.status))
        throw loginRequired(
          response.status === 410 ? 'LOGIN_CONFIRMATION_EXPIRED' : 'LOGIN_REQUIRED',
        );
      if (response.status === 403)
        throw new PluginRequestError('AUTH_PERMISSION_DENIED', '当前账号未获准完成这次认证操作。', {
          httpStatus: 403,
          nextAction: '核对连接码、当前账号及权限，不要反复退出登录。',
        });
      throw new PluginRequestError(
        'AUTH_SERVICE_UNAVAILABLE',
        '认证服务暂时不可用，当前登录信息已保留。',
        {
          httpStatus: response.status,
          retryable: response.status >= 500,
          nextAction: '稍后检查平台或网络后重试原请求，不必退出登录。',
        },
      );
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new PluginRequestError(
        'AUTH_RESPONSE_INVALID',
        '认证服务返回了不可识别响应，请核对平台登录服务。',
        { httpStatus: 502 },
      );
    }
    return { status: response.status, value };
  }
  async function begin() {
    if (pending && pending.expiresAt > now()) return pending;
    if (startPromise) return startPromise;
    const expectedRevision = revision;
    const flight = (async () => {
      const { value } = await request('/api/sso/plugin/start', { body: { audience } });
      assertRevision(expectedRevision);
      let url;
      try {
        url = new URL(value.verificationUrl);
      } catch {
        throw new PluginRequestError('AUTH_RESPONSE_INVALID', '浏览器授权入口无效。');
      }
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== '/api/sso/plugin/authorize' ||
        !/^([a-f0-9]{32})$/.test(value.id ?? '') ||
        !/^([A-Za-z0-9_-]{43})$/.test(value.secret ?? '') ||
        url.searchParams.get('id') !== value.id ||
        [...url.searchParams.keys()].some((key) => key !== 'id') ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= now()
      )
        throw new PluginRequestError('AUTH_RESPONSE_INVALID', '浏览器授权入口无效。');
      pending = value;
      return pending;
    })();
    startPromise = flight;
    try {
      return await flight;
    } finally {
      if (startPromise === flight) startPromise = null;
    }
  }
  function publicPending() {
    return {
      authenticated: false,
      mode,
      needsLogin: true,
      ...(pending
        ? {
            verificationUrl: pending.verificationUrl,
            userCode: pending.userCode,
            expiresAt: pending.expiresAt,
          }
        : {}),
      nextAction: native
        ? '请在Studio账户菜单登录后重新发起任务。'
        : '在浏览器登录自己的账号并确认连接，再调用rdk_auth_status。不要在聊天中发送密码或Cookie。',
    };
  }
  async function clear() {
    revision++;
    cached = null;
    pending = null;
    startPromise = null;
    pollPromise = null;
    try {
      fs.unlinkSync(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function cookie() {
    const expectedRevision = revision;
    if (disconnected)
      throw loginRequired('LOGIN_REQUIRED', '插件已退出，请调用rdk_auth_login重新连接。');
    if (native) {
      const id = env.RDK_STUDIO_LOGIN_ACCOUNT,
        sid = env.RDK_STUDIO_LOGIN_SESSION;
      if (!id || !sid || env.RDK_STUDIO_LOGIN_ORIGIN !== origin)
        throw loginRequired(
          'STUDIO_LOGIN_REQUIRED',
          '请在当前Studio账号菜单登录后重新发起任务；不会改用其他账号。',
        );
      const { value } = await request('/api/sso/plugin/session', {
        body: { audience, accountId: id },
        headers: { 'x-rdk-sso-session': sid },
      });
      assertRevision(expectedRevision);
      if (value.accountId !== id || !safe(value))
        throw new PluginRequestError(
          'STUDIO_ACCOUNT_MISMATCH',
          'Studio与平台的当前账号未匹配，连接已停止。',
          { httpStatus: 403, nextAction: '请重新连接当前Studio账号，不会切换为其他账号。' },
        );
      return value.cookie;
    }
    const saved = await read();
    if (saved && safe(saved)) {
      try {
        const { value } = await request('/api/sso/me', { headers: { cookie: saved.cookie } });
        assertRevision(expectedRevision);
        if (value.user?.id === saved.accountId) return saved.cookie;
      } catch (error) {
        if (!error.needsLogin) throw error;
      }
      await clear();
    }
    const flow = await begin();
    throw loginRequired(
      'LOGIN_REQUIRED',
      '请在浏览器确认连接码 ' + flow.userCode + ' 后调用rdk_auth_status。',
    );
  }
  function unavailable(error) {
    const e = classifyPluginFailure(error);
    if (e.needsLogin) return { ...publicPending(), error: e.code, reason: e.message };
    return {
      authenticated: null,
      mode,
      needsLogin: false,
      error: e.code,
      httpStatus: e.httpStatus,
      retryable: e.retryable,
      ...(native ? { accountId: env.RDK_STUDIO_LOGIN_ACCOUNT } : {}),
      reason: e.message,
      nextAction: e.nextAction ?? '检查连接配置后重试，不必反复登录。',
    };
  }
  async function status() {
    if (disconnected) return { authenticated: false, mode, needsLogin: true };
    if (!native && pending) {
      if (!pollPromise) {
        const expectedRevision = revision,
          flow = pending;
        pollPromise = (async () => {
          const { status: code, value } = await request('/api/sso/plugin/poll', {
            body: { id: flow.id },
            headers: { authorization: 'Bearer ' + flow.secret },
          });
          assertRevision(expectedRevision);
          if (code === 202) return publicPending();
          if (value.status !== 'authenticated')
            throw new PluginRequestError('AUTH_RESPONSE_INVALID', '平台未返回明确的登录确认结果。');
          await save(value, expectedRevision);
          pending = null;
          return null;
        })();
      }
      const flight = pollPromise;
      try {
        const progress = await flight;
        if (progress) return progress;
      } catch (error) {
        if (error.needsLogin || error.httpStatus === 403) pending = null;
        return unavailable(error);
      } finally {
        if (pollPromise === flight) pollPromise = null;
      }
    }
    try {
      await cookie();
      if (native) return { authenticated: true, mode, accountId: env.RDK_STUDIO_LOGIN_ACCOUNT };
      const saved = await read();
      return { authenticated: true, mode, accountId: saved.accountId, expiresAt: saved.expiresAt };
    } catch (error) {
      return unavailable(error);
    }
  }
  return {
    audience,
    mode,
    cookie,
    status,
    async call(name, args = {}) {
      if (
        Object.keys(args).some((key) => key !== 'openBrowser') ||
        (args.openBrowser !== undefined && typeof args.openBrowser !== 'boolean')
      )
        throw new Error('认证工具参数无效');
      if (name === 'rdk_auth_logout') {
        await clear();
        disconnected = true;
        return { authenticated: false, loggedOut: true, studioAccountUnchanged: native };
      }
      if (name === 'rdk_auth_login') {
        disconnected = false;
        if (native) return status();
        loginPromise ??= begin().finally(() => {
          loginPromise = null;
        });
        await loginPromise;
        let opened = false;
        if (args.openBrowser !== false) {
          try {
            await openUrl(pending.verificationUrl);
            opened = true;
          } catch {}
        }
        return { ...publicPending(), browserOpened: opened };
      }
      return status();
    },
    invalidate: clear,
  };
}
function defaultOpen(url) {
  return new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('browser unavailable')),
    );
  });
}
