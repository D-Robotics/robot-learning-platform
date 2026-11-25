/** Update only the explicitly selected learning-platform connection; preserve unrelated host configuration. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { LEARNING_CONNECTION_NAME } from '../configure.mjs';

const knownNames = ['rdk-learning-platform', 'rdk-learning-repaired', LEARNING_CONNECTION_NAME];
const preservedEnv = [
  'RDK_SIM2REAL_MCP_BASE_URL',
  'RDK_WORKSHOP_COMPUTE_RESOURCE_ID',
  'RDK_STUDIO_INHERIT_LOGIN',
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
export function mergeStudioConnection(
  current,
  connection,
  { connectionName, configuredEnv = [] } = {},
) {
  if (!current || typeof current !== 'object' || Array.isArray(current))
    throw Error('Studio MCP配置格式无效；未修改原文件。');
  const servers = current.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw Error('Studio MCP服务器配置格式无效；未修改原文件。');
  const existing = knownNames.filter((name) => Object.hasOwn(servers, name));
  if (!connectionName && existing.length > 1) return { needsSelection: true, choices: existing };
  const selected = connectionName ?? existing[0] ?? LEARNING_CONNECTION_NAME;
  if (!knownNames.includes(selected))
    throw Error('请明确选择学习平台连接；不会覆盖其他MCP服务器。');
  const name =
    selected !== LEARNING_CONNECTION_NAME && !Object.hasOwn(servers, LEARNING_CONNECTION_NAME)
      ? LEARNING_CONNECTION_NAME
      : selected;
  const previous = servers[selected] ?? {};
  const env = { ...connection.env };
  for (const key of preservedEnv) {
    if (!configuredEnv.includes(key) && typeof previous.env?.[key] === 'string')
      env[key] = previous.env[key];
  }
  const mcpServers = { ...servers };
  if (name !== selected) delete mcpServers[selected];
  const disabled = Array.isArray(current.disabled)
    ? [...new Set(current.disabled.map((item) => (item === selected ? name : item)))]
    : null;
  return {
    name,
    configuration: {
      ...current,
      ...(disabled && { disabled }),
      mcpServers: {
        ...mcpServers,
        [name]: {
          ...connection,
          env,
          ...(previous.permissions && { permissions: previous.permissions }),
          // Studio discards managed MCP entries and resolves them from its
          // plugin registry. Setup writes an independent user connection.
        },
      },
    },
    ...(name !== selected && { migratedFrom: selected }),
    wasDisabled: disabled?.includes(name) === true,
  };
}
export function installStudioConnection(
  connection,
  { directory = studioDataDirectory(), connectionName, pluginRoot, configuredEnv } = {},
) {
  if (!fs.existsSync(directory))
    return {
      installed: false,
      needsHostImport: true,
      reason: '未检测到已初始化的Studio数据目录；在宿主插件中心导入当前目录即可。',
    };
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())
    throw Error('Studio数据目录必须是明确的常规目录。');
  const registry = path.join(directory, 'plugins-registry.json');
  if (pluginRoot && fs.existsSync(registry)) {
    const stat = fs.lstatSync(registry);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw Error('Studio 插件登记文件不可安全读取。');
    const record = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins?.[
      'rdk-robot-learning-platform@user'
    ];
    if (
      record?.enabled === true &&
      typeof record.installPath === 'string' &&
      fs.existsSync(record.installPath) &&
      fs.realpathSync(record.installPath) !== fs.realpathSync(pluginRoot)
    )
      return {
        installed: false,
        needsHostImport: true,
        importDirectory: path.resolve(pluginRoot),
        reason:
          '本次只完成了新版配置。请在 Studio 插件中心更新 RDK Robot Learning Platform，选择本次解压后的完整插件目录。若当前 Studio 只提供「导入本地插件」，先移除插件中心的旧条目，再导入这个目录。完成后新建对话，用 rdk_plugin_status 核对运行版本。',
      };
  }
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
  const result = mergeStudioConnection(current, connection, { connectionName, configuredEnv });
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
    ...(result.migratedFrom && { migratedFrom: result.migratedFrom }),
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
