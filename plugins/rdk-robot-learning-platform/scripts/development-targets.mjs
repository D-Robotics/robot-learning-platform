export const DEVELOPMENT_TARGET_TOOL = {
  name: 'rdk_development_targets',
  description:
    '列出当前学习平台账号的算力机和 RDK 板卡。算力机会显示最近一次健康检查报告的引擎；舞蹈训练优先选择支持 originman-dance-ppo 的机器。明确要求检查某台算力机时用 test-compute，明确要求连接某台板卡时用 connect-board。先从对应列表匹配唯一目标，再传准确的 targetId。算力机用于训练，板卡连接仅打开 SSH 隧道并探测 BoardAgent。要换算力机跑 Workshop，用 rdk_workshop 新建实验。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'list-compute', 'test-compute', 'connect-board'] },
      engine: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' },
      local: { type: 'boolean' },
      targetId: { type: 'string', minLength: 1, maxLength: 160 },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};

export async function developmentTargets(args, { authentication, request, baseUrl } = {}) {
  const { action = 'list', targetId, engine, local } = args;
  if (
    Array.isArray(args) ||
    Object.keys(args).some((key) => !['action', 'targetId', 'engine', 'local'].includes(key)) ||
    !['list', 'list-compute', 'test-compute', 'connect-board'].includes(action) ||
    ((engine !== undefined || local !== undefined) && action !== 'list-compute') ||
    (engine !== undefined &&
      (typeof engine !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(engine))) ||
    (local !== undefined && typeof local !== 'boolean') ||
    (['list', 'list-compute'].includes(action)
      ? targetId !== undefined
      : typeof targetId !== 'string' || !targetId.trim() || targetId.length > 160)
  )
    throw Error('请先查看设备列表，再选择明确的一台算力机或板卡。');
  if (!authentication || !request) throw Error('请使用本版完整插件查看开发机。');
  const state = await authentication.status();
  if (state.authenticated !== true || !state.accountId)
    throw Error(state.nextAction ?? '请先登录学习平台，再查看开发机。');
  const { accountId } = state;
  const verifyAccount = async () => {
    const current = await authentication.status();
    if (current.authenticated !== true || current.accountId !== accountId)
      throw Error('当前账号已变化，请重新查看开发机。');
  };
  const delivery = '只展示 studentReply。使用列表中对应类别的唯一目标，名称重复时请用户选择。';
  const list = async (kind) => {
    const body = await request(kind, { accountId });
    const records = kind === 'compute' ? body.computeResources : body.connections;
    if (!Array.isArray(records)) throw Error('平台未返回有效的设备清单。');
    return records
      .filter((record) => typeof record?.id === 'string' && record.id)
      .map((record) => ({
        id: record.id,
        name: (kind === 'compute' ? record.name : record.label) || record.id,
        ...(kind === 'compute'
          ? {
              status: record.status,
              engines: Array.isArray(record.engines) ? record.engines : [],
              mock: record.mock === true,
              ...(action === 'list-compute'
                ? {
                    realWorker: record.mock === false,
                    source: record.source ?? 'server-runner',
                    gpuName: record.gpuName ?? null,
                    cuda: typeof record.cuda === 'boolean' ? record.cuda : null,
                  }
                : {}),
            }
          : { tunnelActive: record.tunnelActive === true }),
      }));
  };
  if (action === 'list-compute') {
    const records = await list('compute');
    await verifyAccount();
    const scoped = records.filter((item) => !local || item.source === 'local-agent');
    const eligible = scoped.filter(
      (item) =>
        item.realWorker &&
        item.status === 'online' &&
        (!engine || item.engines.includes(engine)) &&
        (engine !== 'originman-dance-ppo' || item.source !== 'local-agent'),
    );
    const needsCheck = scoped.filter((item) => !eligible.includes(item));
    const lines = eligible.map(
      ({ name, source, gpuName, cuda }) =>
        `${name}（${source === 'local-agent' ? '本机 Agent' : '平台可访问的 Runner'}${gpuName ? ' · ' + gpuName : cuda === true ? ' · 支持 CUDA' : ' · 设备待确认'}）`,
    );
    const resources = baseUrl ? new URL(baseUrl.replace(/\/+$/, '') + '/#resources').href : null;
    return {
      compute: eligible,
      needsCheck,
      links: resources ? { resources } : {},
      studentReply: [
        lines.length
          ? `可选算力：${lines.join('、')}。你想用哪台？`
          : '当前没有可直接用于这项任务的已验证算力。',
        local && engine === 'originman-dance-ppo'
          ? '舞蹈训练需要平台能访问的 Runner。可以在本机部署独立平台，或将本机 Worker 接入为平台可访问的 Runner。'
          : needsCheck.length
            ? '连接状态或引擎能力待确认的资源，可以在执行资源页检查。'
            : null,
        resources ? `[打开执行资源，检查或添加算力](${resources})` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      delivery,
    };
  }
  if (action === 'list') {
    const [compute, boards] = await Promise.allSettled([list('compute'), list('boards')]);
    await verifyAccount();
    const describe = (label, result) =>
      label +
      '：' +
      (result.status === 'rejected'
        ? '暂时读不到'
        : result.value
            .map((target) =>
              label === '训练算力机'
                ? `${target.name}（${target.status || '状态未知'}；引擎：${target.engines.join('、') || '待测试'}${target.mock ? '；Mock' : ''}）`
                : target.name,
            )
            .join('、') || '当前账号还没有登记');
    return {
      compute: compute.status === 'fulfilled' ? compute.value : null,
      boards: boards.status === 'fulfilled' ? boards.value : null,
      studentReply: [
        describe('训练算力机', compute),
        describe('RDK 板卡', boards),
        '舞蹈训练请选择已报告支持 originman-dance-ppo 且非 Mock 的算力机；状态或能力未知时，先测试连接刷新。',
      ].join('\n'),
      delivery,
    };
  }
  const compute = action === 'test-compute';
  const target = (await list(compute ? 'compute' : 'boards')).find((item) => item.id === targetId);
  if (!target) throw Error('当前账号在对应类别下看不到这台设备，请重新选择。');
  const result = await request(action, { accountId, targetId });
  await verifyAccount();
  if (compute) {
    if (result.computeResource?.id !== targetId) throw Error('平台未确认这台算力机的检查结果。');
    const connected = result.connected === true;
    return {
      target,
      connected,
      studentReply:
        target.name +
        (connected
          ? '可连接。选它新建 Workshop 实验后，再选训练预算。'
          : result.browserRelay
            ? '通过本地 Agent 接入，请在学习平台网页检查连接。'
            : '当前连接检查未通过，请在学习平台查看资源状态。'),
      delivery,
    };
  }
  if (result.connection?.id !== targetId) throw Error('平台未确认这台板卡的连接结果。');
  const tunnelActive = result.connection.tunnelActive === true;
  const agentReady = result.probe?.ok === true;
  return {
    target,
    tunnelActive,
    agentReady,
    studentReply:
      target.name +
      (tunnelActive && agentReady
        ? '已连接，板端服务探测通过。'
        : tunnelActive
          ? 'SSH 隧道已开启，板端服务探测未通过。'
          : '平台尚未确认 SSH 隧道已连接。'),
    delivery,
  };
}
