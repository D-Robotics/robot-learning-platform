/** Public error categories never turn transport failures into a request to sign in again. */
export class PluginRequestError extends Error {
  constructor(
    code,
    message,
    { httpStatus = 500, needsLogin = false, retryable = false, nextAction } = {},
  ) {
    super(message);
    Object.assign(this, { code, httpStatus, needsLogin, retryable, nextAction });
  }
}
export function classifyPluginFailure(error) {
  if (error instanceof PluginRequestError) return error;
  const code = error?.cause?.code ?? error?.code;
  if (
    error?.name === 'TimeoutError' ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)
  )
    return new PluginRequestError('PLATFORM_TIMEOUT', '连接平台超时，当前登录信息已保留。', {
      httpStatus: 504,
      retryable: true,
      nextAction: '检查网络后查询原任务；写操作没有自动重试，不需要退出登录。',
    });
  if (error?.name === 'AbortError')
    return new PluginRequestError(
      'REQUEST_CANCELLED',
      '本次请求已取消；已提交的任务状态需按原Run查询。',
      { httpStatus: 499 },
    );
  if (
    error instanceof TypeError ||
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)
  )
    return new PluginRequestError(
      'PLATFORM_NETWORK_ERROR',
      '暂时无法连接平台，当前登录信息已保留。',
      {
        httpStatus: 502,
        retryable: true,
        nextAction: '检查网络、代理或平台可用性，再查询原任务；不要重复提交或反复登录。',
      },
    );
  return new PluginRequestError('PLUGIN_INTERNAL_ERROR', '插件无法完成本次请求。', {
    httpStatus: 500,
    nextAction: '检查插件配置或诊断信息；不会自动重试写操作。',
  });
}
export function loginRequired(code = 'LOGIN_REQUIRED', message = '登录已失效，请重新登录。') {
  return new PluginRequestError(code, message, {
    httpStatus: 401,
    needsLogin: true,
    nextAction: 'Studio中请在账户菜单重新登录；其他宿主调用rdk_auth_login。',
  });
}
export function publicFailure(error) {
  const e = classifyPluginFailure(error);
  return {
    ok: false,
    error: e.code,
    message: e.message,
    httpStatus: e.httpStatus,
    needsLogin: e.needsLogin,
    retryable: e.retryable,
    ...(e.nextAction ? { nextAction: e.nextAction } : {}),
  };
}
