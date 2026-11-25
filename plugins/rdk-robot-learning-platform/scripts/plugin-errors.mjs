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

const workshopEvidenceMessages = new Map([
  ['binding-missing', '原训练缺少可用于恢复的 Worker 或策略绑定。请由课程管理员核对原训练的记录。'],
  [
    'worker-unavailable',
    '暂时连不上原训练的 Worker。请恢复同一算力资源的连接，再继续原实验的评测。',
  ],
  ['job-missing', '原 Worker 查不到这条任务。请核对 Worker 的数据目录是否仍包含原训练记录。'],
  ['receipt-missing', '原 Worker 尚未返回可用的评测回执。请核对是否保留了原训练的结果文件。'],
  [
    'receipt-mismatch',
    '原 Worker 返回的任务、训练参数或策略校验值与原记录不一致。请核对原始结果文件。',
  ],
]);

export function workshopEvidenceMessage(issue) {
  return workshopEvidenceMessages.get(issue);
}

const specificRecovery = {
  SIM2REAL_API_NOT_FOUND: '确认当前平台版本已经提供这项接口，或在工作台打开相应页面。',
  SIM2REAL_INVALID_COMPUTE_RESOURCE_URL:
    '按错误说明修正协议、主机和 /train 路径，再登记或更新算力。',
  SIM2REAL_INVALID_COMPUTE_RESOURCE_TOKEN:
    '在算力配置中填写和 Worker 一致的 bearer token，再测试连接。',
  SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND:
    '先调用 rdk_compute_resources_list，从当前账号复制有效的 computeResourceId。',
  SIM2REAL_RUN_NOT_FOUND: '在运行列表核对完整 Run ID 和当前账号，再查询原 Run。',
  SIM2REAL_PREFLIGHT_NOT_SUPPORTED: '请平台管理员核对 Worker 的任务和预检能力，再选择支持的资源。',
};

export function toolFailureDetails(
  { code, httpStatus, message, recovery, nextAction, needsLogin },
  name,
) {
  code = typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'MCP_TOOL_FAILED';
  let category = 'unknown';
  let action = Object.hasOwn(specificRecovery, code) ? specificRecovery[code] : undefined;
  if (needsLogin || httpStatus === 401 || /LOGIN_REQUIRED|AUTH_REQUIRED|AUTH_EXPIRED/.test(code)) {
    category = 'authentication';
    action = '调用 rdk_auth_login 并在浏览器完成授权。Studio 使用账号继承时，请先在账户菜单登录。';
  } else if (httpStatus === 403 || code === 'PERMISSION_DENIED') {
    category = 'permission';
    action = '核对当前账号对目标记录的访问权限，或请资源所有者确认授权。';
  } else if (httpStatus === 404 || code?.endsWith('_NOT_FOUND')) {
    category = 'not-found';
    action ??= '先列表查询当前账号的记录，再使用完整 ID 重试查询。';
  } else if (httpStatus === 409 || code === 'DSH_STATE_CONFLICT') {
    category = 'state-conflict';
    action = '检查原记录的状态和版本；提交类操作先按原标识查询结果。';
  } else if (
    /NETWORK|TRANSPORT|TIMEOUT|FETCH_FAILED/.test(code) ||
    code === 'DSH_TRANSPORT_FAILED'
  ) {
    category = 'transport';
    action = '检查插件配置的平台地址、网络和代理，再调用 rdk_platform_status 检查连接。';
  } else if (
    code === 'DSH_CAPABILITY_REJECTED' ||
    /INVALID|REJECTED/.test(code) ||
    httpStatus === 400 ||
    httpStatus === 422
  ) {
    category = 'invalid-arguments';
    action ??= '按错误说明和 ' + name + ' 的参数表修正输入后再试。';
  } else if (code === 'DSH_CAPABILITY_FAILED' || httpStatus >= 500) {
    category = 'platform-configuration';
    action ??= '调用 rdk_platform_status 核对平台；若服务可用，请维护者检查这项能力的配置。';
  }
  const legacyPlaceholder = '保留返回的实体 ID，检查平台状态、日志与前置条件。';
  const provided =
    typeof nextAction === 'string' && nextAction.trim()
      ? nextAction
      : typeof recovery === 'string' && recovery.trim() !== legacyPlaceholder
        ? recovery.trim()
        : null;
  return {
    platformCode: code || 'MCP_TOOL_FAILED',
    message,
    ...(Number.isInteger(httpStatus) && { httpStatus }),
    category,
    recovery:
      category === 'authentication'
        ? action
        : provided ||
          action ||
          '根据错误说明检查 ' + name + ' 的前置条件；涉及提交时先查询原任务状态。',
  };
}

export function enrichToolError(result, name) {
  if (!result.isError) return result;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  let data = result.structuredContent;
  if (!data && text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* older retained core uses a text envelope */
    }
  }
  const nested = data?.error && typeof data.error === 'object' ? data.error : {};
  const match = /^\[([A-Z][A-Z0-9_]+)\]\s+([\s\S]*)$/.exec(text ?? '');
  const code =
    nested.platformCode ??
    nested.code ??
    data?.platformCode ??
    data?.code ??
    (typeof data?.error === 'string' ? data.error : match?.[1]);
  const message = nested.message ?? data?.message ?? match?.[2] ?? text ?? '工具调用失败。';
  const error = toolFailureDetails(
    {
      code,
      message,
      httpStatus: nested.httpStatus ?? data?.httpStatus,
      nextAction: nested.nextAction ?? data?.nextAction,
      recovery: nested.recovery ?? (typeof data?.recovery === 'string' ? data.recovery : undefined),
      needsLogin: nested.needsLogin ?? data?.needsLogin,
    },
    name,
  );
  const payload = {
    ...data,
    ok: false,
    recovery: data?.recovery && typeof data.recovery === 'object' ? data.recovery : error.recovery,
    error: { ...nested, ...error },
  };
  return {
    ...result,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}
