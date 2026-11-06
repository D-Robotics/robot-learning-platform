#!/usr/bin/env node
/** Configure an installed directory with public connection metadata only. No passwords or session files. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export function supportedNode(version, range = '^22.22.2 || ^24.15.0 || >=26.0.0') {
  const actual = String(version).replace(/^v/, '').split('.').map(Number);
  return range.split('||').some((clause) => {
    const match = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(clause.trim());
    if (!match) return false;
    const floor = match.slice(2).map(Number);
    const atLeast =
      actual[0] > floor[0] ||
      (actual[0] === floor[0] &&
        (actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2])));
    return atLeast && (match[1] === '>=' || actual[0] === floor[0]);
  });
}
export function createMcpConfiguration({
  root,
  nodePath,
  platformUrl = 'https://rdkstudio.d-robotics.cc/robotics-learning',
  platform = process.platform,
  courseResourceId,
  inheritStudioLogin = false,
}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || !paths.isAbsolute(nodePath))
    throw Error('插件目录与Node运行时必须使用绝对路径。');
  if (courseResourceId !== undefined && !/^[a-f0-9-]{8,100}$/i.test(courseResourceId))
    throw Error('课程资源标识无效；请使用当前账号可见的已登记资源。');
  const url = new URL(platformUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/robotics-learning', '/sim2real', ''].includes(url.pathname.replace(/\/$/, ''))
  )
    throw Error('平台地址必须为HTTPS学习平台地址；本机测试可用HTTP回环地址。');
  return {
    mcpServers: {
      'rdk-learning-platform': {
        type: 'stdio',
        command: nodePath,
        args: [paths.join(root, 'scripts', 'experience-mcp.mjs')],
        env: {
          RDK_STUDIO_INHERIT_LOGIN: inheritStudioLogin ? '1' : '0',
          ...(courseResourceId ? { RDK_WORKSHOP_COMPUTE_RESOURCE_ID: courseResourceId } : {}),
          RDK_SIM2REAL_MCP_BASE_URL: url.href.replace(/\/$/, ''),
        },
      },
    },
  };
}
export function configurePlugin({
  root = path.dirname(fileURLToPath(import.meta.url)),
  nodePath = process.execPath,
  platformUrl,
  platform = process.platform,
  nodeVersion = process.versions.node,
  courseResourceId,
  inheritStudioLogin = false,
} = {}) {
  const required = JSON.parse(
    fs.readFileSync(path.join(root, 'runtime-requirements.json'), 'utf8'),
  ).node;
  if (!supportedNode(nodeVersion, required))
    throw Error('当前Node版本不支持，请双击本系统的setup安装入口，自动准备兼容运行时。');
  for (const name of ['mcp/bundle.mjs', 'scripts/experience-mcp.mjs'])
    if (!fs.statSync(path.join(root, name)).isFile()) throw Error('请从完整插件目录运行安装配置。');
  const manifest = createMcpConfiguration({
    root,
    nodePath,
    platformUrl,
    platform,
    courseResourceId,
    inheritStudioLogin,
  });
  const target = path.join(root, '.mcp.json');
  const temp = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { configured: true, manifest, target };
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    let platformUrl;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--platform-url')
        throw Error(
          '用法：node configure.mjs [--platform-url <平台地址>]；登录请使用浏览器，不接受密码或凭据文件。',
        );
      platformUrl = args[1];
    }
    const result = configurePlugin({ platformUrl });
    console.log(
      JSON.stringify({
        ok: true,
        configured: result.configured,
        credentialsStored: false,
        nextAction: '导入此插件目录，或在宿主注册生成的.mcp.json；首次登录按浏览器提示确认。',
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
