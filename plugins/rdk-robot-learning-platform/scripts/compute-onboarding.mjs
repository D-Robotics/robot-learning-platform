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
