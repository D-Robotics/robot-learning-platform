/** Update only the explicitly selected learning-platform connection; preserve unrelated host configuration. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const knownNames = [
  'rdk-learning-platform',
  'rdk-learning-repaired',
  'rdk-robot-learning-platform',
];
export function studioDataDirectory({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.RDK_DATA_DIR) return paths.resolve(env.RDK_DATA_DIR);
  if (platform === 'win32')
    return paths.join(env.APPDATA || paths.join(home, 'AppData', 'Roaming'), 'rdk-studio', 'data');
  if (platform === 'darwin')
    return paths.join(home, 'Library', 'Application Support', 'rdk-studio', 'data');
  return paths.join(home, '.config', 'rdk-studio', 'data');
}
export function mergeStudioConnection(current, connection, { connectionName } = {}) {
  if (!current || typeof current !== 'object' || Array.isArray(current))
    throw Error('Studio MCP配置格式无效；未修改原文件。');
  const servers = current.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw Error('Studio MCP服务器配置格式无效；未修改原文件。');
  const existing = knownNames.filter((name) => Object.hasOwn(servers, name));
  if (!connectionName && existing.length > 1) return { needsSelection: true, choices: existing };
  const name = connectionName ?? existing[0] ?? 'rdk-learning-platform';
  if (!knownNames.includes(name)) throw Error('请明确选择学习平台连接；不会覆盖其他MCP服务器。');
  return {
    name,
    configuration: {
      ...current,
      mcpServers: {
        ...servers,
        [name]: { ...connection, managedPlugin: 'rdk-robot-learning-platform' },
      },
    },
    wasDisabled: Array.isArray(current.disabled) && current.disabled.includes(name),
  };
}
export function installStudioConnection(
  connection,
  { directory = studioDataDirectory(), connectionName } = {},
) {
  if (!fs.existsSync(directory))
    return {
      installed: false,
      needsHostImport: true,
      reason: '未检测到已初始化的Studio数据目录；在宿主插件中心导入当前目录即可。',
    };
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())
    throw Error('Studio数据目录必须是明确的常规目录。');
  const target = path.join(directory, 'mcp.json');
  let existing = null,
    current = { mcpServers: {} };
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw Error('Studio MCP配置不是可安全更新的常规文件。');
    existing = fs.readFileSync(target);
    current = JSON.parse(existing.toString('utf8'));
  }
  const result = mergeStudioConnection(current, connection, { connectionName });
  if (result.needsSelection) return { installed: false, ...result };
  const output = JSON.stringify(result.configuration, null, 2) + '\n';
  if (existing?.toString('utf8') === output)
    return { installed: true, unchanged: true, name: result.name, wasDisabled: result.wasDisabled };
  const suffix = randomBytes(8).toString('hex');
  const temp = target + '.' + suffix + '.tmp';
  let backup;
  try {
    fs.writeFileSync(temp, output, { mode: 0o600, flag: 'wx' });
    // A concurrent host edit must never be lost between preparation and publication.
    if (existing) {
      if (!fs.readFileSync(target).equals(existing))
        throw Error('Studio配置正在被修改，请稍后重试；未覆盖原文件。');
      backup = target + '.before-learning-' + suffix;
      fs.writeFileSync(backup, existing, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, target);
    } else {
      fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return {
    installed: true,
    name: result.name,
    wasDisabled: result.wasDisabled,
    ...(backup ? { backupCreated: true } : {}),
  };
}

export function detectStudioApp({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const candidates =
    platform === 'darwin'
      ? ['/Applications/RDK Studio.app', paths.join(home, 'Applications', 'RDK Studio.app')]
      : platform === 'win32'
        ? [
            ...(env.LOCALAPPDATA
              ? [
                  paths.join(env.LOCALAPPDATA, 'Programs', 'rdk-studio'),
                  paths.join(env.LOCALAPPDATA, 'Programs', 'RDK Studio'),
                ]
              : []),
            ...(env.ProgramFiles
              ? [
                  paths.join(env.ProgramFiles, 'RDK Studio'),
                  paths.join(env.ProgramFiles, 'rdk-studio'),
                ]
              : []),
          ]
        : [];
  const found = candidates.filter((app) =>
    exists(
      paths.join(
        app,
        ...(platform === 'darwin'
          ? ['Contents', 'Resources', 'app.asar']
          : ['resources', 'app.asar']),
      ),
    ),
  );
  return found.length === 1 ? found[0] : null;
}
