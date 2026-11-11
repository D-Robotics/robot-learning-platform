#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configurePlugin } from './configure.mjs';
import { installStudioConnection, detectStudioApp } from './scripts/install-host.mjs';

import { installStudioLoginPatch } from './scripts/studio-login-patch.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        '--platform-url',
        '--studio-data-dir',
        '--connection-name',
        '--host',
        '--studio-app',
        '--studio-login',
        '--resource-id',
      ].includes(args[i]) ||
      !args[i + 1]
    )
      throw Error('安装参数无效。');
    if (options[args[i]]) throw Error('安装参数重复。');
    options[args[i]] = args[i + 1];
  }
  if (options['--host'] && !['studio', 'other', 'qoder'].includes(options['--host']))
    throw Error('host只支持studio、other或qoder。');
  const inheritStudioLogin = options['--studio-login'] === 'inherit';
  if (
    options['--studio-login'] &&
    (!inheritStudioLogin || ['other', 'qoder'].includes(options['--host']))
  )
    throw Error('只有 Studio 支持显式启用 --studio-login inherit。');
  const configured = configurePlugin({
    root,
    platformUrl: options['--platform-url'],
    courseResourceId: options['--resource-id'],
    inheritStudioLogin,
  });
  const installed = ['other', 'qoder'].includes(options['--host'])
    ? { installed: false, needsHostImport: true }
    : installStudioConnection(configured.manifest.mcpServers['rdk-learning-platform'], {
        directory: options['--studio-data-dir'],
        connectionName: options['--connection-name'],
        pluginRoot: root,
      });
  let loginInheritance;
  const patchFile = path.join(root, 'host', 'host-patch.json');
  const app = inheritStudioLogin && (options['--studio-app'] ?? detectStudioApp());
  if (app && fs.existsSync(patchFile)) {
    try {
      loginInheritance = installStudioLoginPatch({
        appPath: app,
        patch: JSON.parse(fs.readFileSync(patchFile, 'utf8')),
      });
    } catch (error) {
      loginInheritance = { installed: false, reason: error.message };
    }
  }
  const qoderImport =
    options['--host'] === 'qoder'
      ? (await import('./scripts/qoder-install.mjs')).createQoderImportZip(root)
      : null;
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')).version;
  console.log(
    JSON.stringify({
      pluginVersion,
      ok: true,
      configured: true,
      ...installed,
      credentialsStored: false,
      ...(qoderImport ? { qoderImport } : {}),
      ...(loginInheritance ? { loginInheritance } : {}),
    }),
  );
  console.log(
    '已配置机器人学习插件 ' +
      pluginVersion +
      '，连接：' +
      (installed.name ?? '等待宿主导入') +
      '。新建对话核对实际版本；本地引导无需登录，平台任务另行核对账号。',
  );
  if (qoderImport)
    console.log(
      'Qoder桌面：扩展→已安装→添加→上传Plugin，选择刚生成的“Qoder本机导入包.zip”。这是本机配置副本，不要转发；共享请使用原始发行ZIP。',
    );
  if (loginInheritance?.installed === false)
    console.log(
      'Studio自动登录接线尚未安装：' + loginInheritance.reason + ' 当前仍可使用浏览器授权。',
    );
  else if (loginInheritance?.restartRequired)
    console.log('Studio登录接线已更新，请重新打开Studio。');
  if (installed.needsSelection)
    console.log(
      '发现多条已有学习平台连接，请保留并明确选择要更新的一条：' +
        installed.choices.join(', ') +
        '。使用 --connection-name 指定，未修改宿主原配置。',
    );
  else if (installed.wasDisabled)
    console.log('连接已配置。您此前禁用了这条连接，请在Studio设置中启用后继续。');
  else if (installed.installed)
    console.log(
      '安装配置完成。在 Studio 说“打开机器人学习工作台”开始。需要访问平台数据时再说“连接学习平台”。',
    );
  else
    console.log(
      installed.reason ??
        '配置已生成。导入完整插件目录即可使用本地知识；需要平台数据时再按浏览器提示登录。',
    );
} catch (error) {
  console.error('安装配置未完成：' + error.message);
  process.exitCode = 1;
}
