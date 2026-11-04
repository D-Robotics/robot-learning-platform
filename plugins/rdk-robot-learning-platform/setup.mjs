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
        '--resource-id',
      ].includes(args[i]) ||
      !args[i + 1]
    )
      throw Error('安装参数无效。');
    if (options[args[i]]) throw Error('安装参数重复。');
    options[args[i]] = args[i + 1];
  }
  if (options['--host'] && !['studio', 'other'].includes(options['--host']))
    throw Error('host只支持studio或other。');
  const configured = configurePlugin({
    root,
    platformUrl: options['--platform-url'],
    courseResourceId: options['--resource-id'],
  });
  const installed =
    options['--host'] === 'other'
      ? { installed: false, needsHostImport: true }
      : installStudioConnection(configured.manifest.mcpServers['rdk-learning-platform'], {
          directory: options['--studio-data-dir'],
          connectionName: options['--connection-name'],
        });
  let loginInheritance;
  const patchFile = path.join(root, 'host', 'host-patch.json');
  const app = options['--studio-app'] ?? detectStudioApp();
  if (options['--host'] !== 'other' && app && fs.existsSync(patchFile)) {
    try {
      loginInheritance = installStudioLoginPatch({
        appPath: app,
        patch: JSON.parse(fs.readFileSync(patchFile, 'utf8')),
      });
    } catch (error) {
      loginInheritance = { installed: false, reason: error.message };
    }
  }
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')).version;
  console.log(
    JSON.stringify({
      pluginVersion,
      ok: true,
      configured: true,
      ...installed,
      credentialsStored: false,
      ...(loginInheritance ? { loginInheritance } : {}),
    }),
  );
  console.log(
    '已配置机器人学习插件 ' +
      pluginVersion +
      '，连接：' +
      (installed.name ?? '等待宿主导入') +
      '。新建对话先核对插件返回的实际版本与登录状态。',
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
      '安装配置完成。请在Studio新建对话，说：帮我做一次OriginMan受扰恢复短训练，评测后播放本次回放。首次无登录时按浏览器提示确认。',
    );
  else console.log('配置已生成。请在宿主中导入当前插件目录或.mcp.json，然后按浏览器提示登录。');
} catch (error) {
  console.error('安装配置未完成：' + error.message);
  process.exitCode = 1;
}
