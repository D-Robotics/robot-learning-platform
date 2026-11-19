import fs from 'node:fs';
import path from 'node:path';

/** Read credentials locally. They never become MCP arguments or tool results. */
export function readWorkerConnection(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename))
    throw Error('请提供 Worker 私有配置文件的绝对路径。');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid()))
    )
      throw Error('Worker 配置必须是当前用户拥有的私有常规文件。');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['name', 'runnerUrl', 'runnerToken', 'maxConcurrentJobs'].includes(key),
      ) ||
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      value.name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(value.name) ||
      typeof value.runnerUrl !== 'string' ||
      (value.runnerToken !== undefined &&
        (typeof value.runnerToken !== 'string' ||
          !/^[\x21-\x7e]{1,4096}$/.test(value.runnerToken))) ||
      (value.maxConcurrentJobs !== undefined &&
        (!Number.isInteger(value.maxConcurrentJobs) ||
          value.maxConcurrentJobs < 1 ||
          value.maxConcurrentJobs > 32))
    )
      throw Error('Worker 私有配置格式无效。');
    const url = new URL(value.runnerUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/train')
    )
      throw Error('Worker 地址必须是无内嵌凭据的 HTTP(S) /train 地址。');
    return { ...value, name: value.name.trim(), runnerUrl: url.href };
  } finally {
    fs.closeSync(fd);
  }
}

export async function registerExistingWorker(connectionFile, { authentication, request }) {
  const state = await authentication.status();
  if (!state.authenticated || !state.accountId) throw Error('请先连接学习平台账号。');
  const accountId = state.accountId;
  const input = readWorkerConnection(connectionFile);
  const assertAccount = async () => {
    const current = await authentication.status();
    if (!current.authenticated || current.accountId !== accountId)
      throw Error('当前账号已变化，请重新登记开发机。');
  };
  const listed = await request('compute', { accountId });
  if (!Array.isArray(listed.computeResources)) throw Error('平台未返回有效算力清单。');
  const matches = listed.computeResources.filter((r) => r.runnerUrl === input.runnerUrl);
  if (matches.length > 1) throw Error('该 Worker 已有多个登记，请先选择准确的资源。');
  await assertAccount();
  let resource = matches[0];
  if (resource && resource.name !== input.name)
    throw Error('该 Worker 已使用另一名称登记，请使用已有资源。');
  if (!resource) {
    const registered = await request('register-compute', { accountId, input });
    resource = registered.computeResource;
    if (!resource?.id || resource.runnerUrl !== input.runnerUrl)
      throw Error('平台未确认原 Worker 的登记结果；请先查清单再重试。');
  }
  await assertAccount();
  const checked = await request('test-compute', { accountId, targetId: resource.id });
  await assertAccount();
  if (checked.computeResource?.id !== resource.id) throw Error('平台未确认这台开发机的连接结果。');
  const worker = checked.computeResource;
  return {
    computeResourceId: resource.id,
    connected: checked.connected === true,
    engines: Array.isArray(worker.engines) ? worker.engines : [],
    studentReply:
      checked.connected === true
        ? `${input.name}已登记，连接测试通过。`
        : `${input.name}已登记，连接测试未通过。请检查 Worker 和平台之间的网络后测试原资源。`,
    delivery: '展示 studentReply 和资源标识。凭据只从私有配置读取。',
  };
}

/** One source-bound installation request; polling never starts a second installation. */
export async function deployStudioWorker(args, { authentication, request }) {
  const action = args?.action;
  const allowed =
    action === 'list-ssh'
      ? ['action']
      : action === 'deploy-compute'
        ? ['action', 'targetId', 'name', 'runnerUrl', 'port']
        : ['action', 'deploymentId'];
  if (!args || Array.isArray(args) || Object.keys(args).some((key) => !allowed.includes(key)))
    throw Error('请使用明确的 Studio 设备和原部署标识。');
  if (
    action === 'deploy-compute' &&
    (typeof args.targetId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(args.targetId) ||
      typeof args.name !== 'string' ||
      !args.name.trim() ||
      args.name.length > 120 ||
      typeof args.runnerUrl !== 'string' ||
      args.runnerUrl.length > 2048 ||
      (args.port !== undefined &&
        (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535)))
  )
    throw Error('请选择 Studio 中的开发机，填写算力名称和平台可访问的 Worker /train 地址。');
  if (action === 'deployment-status' && !/^[a-f0-9]{64}$/.test(args.deploymentId ?? ''))
    throw Error('请使用原部署返回的 deploymentId。');
  const state = await authentication.status();
  if (!state.authenticated || !state.accountId) throw Error('请先连接学习平台账号。');
  const accountId = state.accountId;
  const verify = async () => {
    const current = await authentication.status();
    if (!current.authenticated || current.accountId !== accountId)
      throw Error('账号已变化，请用当前账号查看部署状态。');
  };
  if (action === 'list-ssh') {
    const catalog = await request('ssh-devices', { accountId });
    await verify();
    if (!Array.isArray(catalog.studioDevices)) throw Error('Studio 未返回有效设备清单。');
    const devices = catalog.studioDevices
      .filter((device) => device.provider === 'studio-local-bridge')
      .map((device) => ({
        id: device.id,
        name: device.name || device.id,
        status: device.status,
      }));
    return {
      devices,
      studentReply: devices.length
        ? 'Studio 已共享的开发机：' +
          devices.map((device) => device.name).join('、') +
          '。请选择要部署 Worker 的设备。'
        : '当前账号没有共享的 Studio SSH 设备，请先在 Studio 连接并共享开发机。',
      delivery: '按唯一设备名称匹配 ID。安装前说明 starter-ppo、CPU 和平台可访问的 Worker 地址。',
    };
  }
  await verify();
  const report =
    action === 'deploy-compute'
      ? await request('deploy-compute', {
          accountId,
          input: {
            deviceId: args.targetId,
            name: args.name,
            runnerUrl: args.runnerUrl,
            ...(args.port !== undefined ? { port: args.port } : {}),
          },
        })
      : await request('deployment-status', { accountId, deploymentId: args.deploymentId });
  await verify();
  if (
    !/^[a-f0-9]{64}$/.test(report.deploymentId ?? '') ||
    (action === 'deployment-status' && report.deploymentId !== args.deploymentId)
  )
    throw Error('平台未确认原部署标识，请先查看原部署记录。');
  const output = {
    deploymentId: report.deploymentId,
    state: report.state,
    engine: 'starter-ppo',
    trainingDevice: 'cpu',
  };
  if (report.state === 'registered') {
    if (typeof report.computeResourceId !== 'string' || !report.computeResourceId)
      throw Error('平台未确认登记的算力 ID。');
    const tested = await request('test-compute', { accountId, targetId: report.computeResourceId });
    await verify();
    if (tested.computeResource?.id !== report.computeResourceId)
      throw Error('平台未确认原 Worker 的连接检查结果。');
    return {
      ...output,
      computeResourceId: report.computeResourceId,
      connected: tested.connected === true,
      engines: Array.isArray(tested.computeResource.engines) ? tested.computeResource.engines : [],
      studentReply:
        tested.connected === true
          ? 'Worker 已通过 Studio SSH 安装、登记，平台连接测试通过。当前提供 starter-ppo CPU 训练。'
          : 'SSH 安装和登记已完成，平台连接测试未通过。请检查 Worker 地址的网络和 HTTPS 代理，沿用原算力 ID 测试。',
    };
  }
  if (['starting', 'installing', 'unconfirmed'].includes(report.state))
    return {
      ...output,
      nextTool: 'rdk_development_targets',
      nextArguments: { action: 'deployment-status', deploymentId: report.deploymentId },
      studentReply:
        report.state === 'unconfirmed'
          ? '尚未确认安装启动。保留原部署标识并查询状态。'
          : '开发机正在安装 Worker 和 CPU 训练依赖。继续查询原部署状态。',
      delivery: '等待后调用 nextTool 查询原部署，不重复开始安装。',
    };
  return {
    ...output,
    ...(report.code ? { code: report.code } : {}),
    studentReply:
      '原部署当前状态为 ' + report.state + '。保留部署标识，检查 Studio SSH 和安装环境后继续查询。',
    delivery: '安装未就绪，保留原部署，不宣称登记或训练成功。',
  };
}
