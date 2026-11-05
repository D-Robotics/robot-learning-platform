#!/usr/bin/env node
/** Add host-neutral workflow tools to an independently verified portable MCP bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPluginAuthRelease } from './verify-plugin-auth-release.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (
  ![4, 6].includes(args.length) ||
  args[0] !== '--base-plugin' ||
  args[2] !== '--output' ||
  (args.length === 6 && args[4] !== '--studio-login-patch')
)
  throw new Error(
    'Usage: node scripts/build-workflow-plugin.mjs --base-plugin <unconfigured portable plugin> --output <new-directory> [--studio-login-patch <host-patch.json>]',
  );
const base = path.resolve(args[1]),
  out = path.resolve(args[3]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(fs.readFileSync(path.join(base, 'provenance.json'), 'utf8'));
const bundle = fs.readFileSync(path.join(base, 'mcp/bundle.mjs'));
if (sha(bundle) !== provenance.bundleSha256)
  throw new Error('Base bundle does not match retained provenance.');
const baseConfig = fs.readFileSync(path.join(base, '.mcp.json'), 'utf8');
if (!baseConfig.includes('throw new Error') || baseConfig.includes('credentials-file'))
  throw new Error('Use an unconfigured distribution, never a privately configured installation.');
fs.mkdirSync(out, { recursive: false });
fs.cpSync(base, out, {
  recursive: true,
  dereference: false,
  filter: (file) => {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Base plugin contains symlink.');
    return !['.local', 'node_modules', '.DS_Store'].includes(path.basename(file));
  },
});
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
const sources = {};
for (const name of [
  'experience.mjs',
  'experience-mcp.mjs',
  'workflow-inspection.mjs',
  'experiment-context.mjs',
  'short-training.mjs',
  'plugin-auth.mjs',
  'authenticated-core.mjs',
  'plugin-errors.mjs',
  'course-setup.mjs',
  'submission-journal.mjs',
  'install-host.mjs',
  'studio-login-patch.mjs',
]) {
  const bytes = fs.readFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/scripts', name),
  );
  fs.writeFileSync(path.join(out, 'scripts', name), bytes);
  sources['scripts/' + name] = sha(bytes);
}
const windowsBinding = fs.readFileSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/windows-binding.mjs'),
);
fs.writeFileSync(path.join(out, 'windows-binding.mjs'), windowsBinding);
sources['windows-binding.mjs'] = sha(windowsBinding);
const windowsSetup = fs.readFileSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/setup-windows.cmd'),
);
fs.writeFileSync(path.join(out, 'setup-windows.cmd'), windowsSetup);
sources['setup-windows.cmd'] = sha(windowsSetup);
fs.writeFileSync(
  path.join(out, 'scripts/start-core-mcp.mjs'),
  `import { main } from '../mcp/bundle.mjs';await main();\n`,
);
for (const name of [
  'configure.mjs',
  'setup.mjs',
  'setup-windows.ps1',
  'setup-macos.command',
  'runtime-downloads.json',
]) {
  const bytes = fs.readFileSync(path.join(root, 'plugins/rdk-robot-learning-platform', name));
  fs.writeFileSync(path.join(out, name), bytes);
  if (name.endsWith('.command')) fs.chmodSync(path.join(out, name), 0o755);
  sources[name] = sha(bytes);
}
for (const name of ['experience-profile.json', 'experience-profile-microduck.json'])
  fs.copyFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/references', name),
    path.join(out, 'references', name),
  );
for (const name of ['experience-preparation', 'training-runs']) {
  fs.mkdirSync(path.join(out, 'skills', name), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/skills', name, 'SKILL.md'),
    path.join(out, 'skills', name, 'SKILL.md'),
  );
}
// Preserve all relative skill/reference links, without adding local configuration.
fs.cpSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/references'),
  path.join(out, 'references'),
  { recursive: true },
);
fs.cpSync(path.join(root, 'plugins/rdk-robot-learning-platform/skills'), path.join(out, 'skills'), {
  recursive: true,
});
if (args[5]) {
  const bytes = fs.readFileSync(path.resolve(args[5]));
  const patch = JSON.parse(bytes);
  if (!patch.files || !Object.keys(patch.files).length) throw Error('Studio login patch is empty.');
  fs.mkdirSync(path.join(out, 'host'), { recursive: true });
  fs.writeFileSync(path.join(out, 'host', 'host-patch.json'), bytes);
  sources['host/host-patch.json'] = sha(bytes);
}
const setup = path.join(out, 'skills/setup/SKILL.md');
fs.writeFileSync(
  setup,
  `---
name: setup
description: 连接当前机器人学习平台，确认正式身份与明确模型，再按真实工具能力执行训练与评测。
---

这是自包含便携插件，不需要平台源码或 npm install。Windows双击setup-windows.cmd，macOS双击setup-macos.command；安装器会准备兼容运行时、生成配置并接入已初始化的Studio。其他宿主导入安装目录的.mcp.json。无须手写凭据。每次先调用 rdk_platform_status，确认目标平台、正式身份和工具目录；导入版本不等于连接已切换。宿主存在旧的同类 MCP 连接时，更新那条连接的启动配置，不绕过认证或随意添加重复连接。

训练与评测先读 ../training-runs/SKILL.md。OriginMan 的登记材料在 ../../references/originman-manifest.json；使用真实原文，不补造 manifest。模型列表若只有 ID，读取明确任务的运行记录和对应血缘确认模型与契约，不按顺序猜、不误用 MicroDuck。不具备读取引用文件的宿主，应请用户选明确模型，不能假装已经读到文件。

以实际 tools/list 为准：预检接口缺失时保持未验证，不能声称环境已就绪；可用已支持的模型校验、资源测试和经授权的短训练验证。默认 GPU，CPU 必须显式选择；GPU不可用不自动降级。训练 device=cuda 不表示物理仿真也在 GPU。

提交成功保存 contextId 和原 Run；同源评测使用相同参数、sourceRunId 与独立幂等键。断线后恢复原引用，不自动重交。结果执行完成、效果门和真机资格分别报告。只有宿主实际打开且视频播放后才称回放通过。
`,
);

fs.appendFileSync(
  setup,
  '\n实验连续操作先读 ../training-runs/SKILL.md；提交后保存明确contextId，恢复原Run而不是重交。默认GPU，CPU必须显式选择。平台版本和引擎以实际工具回执为准。\n',
);
fs.appendFileSync(
  setup,
  '\n宿主安装与连接诊断参考 [客户端接入](../../references/client-setup.md)、[连接契约](../../references/connection-contract.md)、[用户工作流](../../references/user-journeys.md) 和 [仓库能力](../../references/cli-capabilities.md)。便携包优先使用本版安装器与浏览器授权。\n',
);
const identity = {
  name: 'rdk-robot-learning-platform',
  version: '0.3.2',
  description: '通用机器人学习工作流：实验接续、训练、评测、回放与失败诊断；GPU默认、CPU显式选择。',
};
fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify(identity, null, 2));
for (const directory of ['.rdstudio-plugin', '.codex-plugin', '.qoder-plugin']) {
  fs.mkdirSync(path.join(out, directory), { recursive: true });
  fs.writeFileSync(
    path.join(out, directory, 'plugin.json'),
    JSON.stringify(
      {
        ...identity,
        displayName: 'RDK Robot Learning Platform',
        mcpServers: './.mcp.json',
        skills: './skills',
        ...(directory === '.qoder-plugin' ? {} : { defaultEnabled: true }),
      },
      null,
      2,
    ),
  );
}
fs.renameSync(path.join(out, 'provenance.json'), path.join(out, 'upstream-provenance.json'));
fs.writeFileSync(
  path.join(out, 'provenance.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      ...identity,
      composition: 'retained-core-with-host-neutral-workflow-extension',
      coreBundleSha256: sha(bundle),
      coreVersion: provenance.version,
      wrapperSources: sources,
      studioHostPatchIncluded: Boolean(args[5]),
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(out, 'README.md'),
  '# Robot Learning Workshop 插件 0.3.2\n\n解压到最终目录后，Windows 双击 setup-windows.cmd，macOS 双击 setup-macos.command。\n安装器自动准备兼容 Node、校验下载摘要、生成配置，并接入已初始化的 Studio。\n不需要平台源码、npm install、手写密码或 Cookie。其他宿主导入生成的 .mcp.json。\n完整说明见 references/workshop-first-run.md。\n\n支持登录继承的 Studio 自动复用当前任务账号；配套接线适配 Windows/macOS 安装路径，\n只修改文件摘要匹配的宿主，并保留备份。不停止正在进行的任务；版本不兼容不强行覆盖。\n其他宿主使用 rdk_auth_login 打开浏览器确认，再调用 rdk_auth_status。\n\n已有统一账号，无须提前访问学习平台。首次训练不依赖成功历史；资源就绪后按需登记课程模型。\n教师须先分配学员可见的计算资源；插件不会借用其他账号资源或自动开通计费算力。\n\n学员可以说：帮我做一次 OriginMan 受扰恢复短训练，评测后播放本次回放。\n固定短训仅仿真，8192 步 SAC+GPU；参数调整走平台工作台或公开提交工具。\n\n网络异常保留登录；断线、超时与重复点击不重交。重启后按同一实验引用恢复原 Run。\n评测核对父 Run 与策略摘要；completed 不等于学会，链接也不等于视频已经播放。\n\n底层便携核心来源见 upstream-provenance.json，扩展摘要见 provenance.json，文件摘要见 FILES.sha256。\n原始分享包不含凭据；配置后含本机路径，不要把配置后的私人副本再分发。\n',
);
const windowsResultFile = path.join(out, 'WINDOWS_RESULT_TEMPLATE.json');
if (fs.existsSync(windowsResultFile)) {
  const template = JSON.parse(fs.readFileSync(windowsResultFile, 'utf8'));
  template.candidateVersion = identity.version;
  fs.writeFileSync(windowsResultFile, JSON.stringify(template, null, 2) + '\n');
}
const authorizationGate = verifyPluginAuthRelease(out);
const entries = [];
function inventory(directory) {
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (entry.isFile() && file !== path.join(out, 'FILES.sha256'))
      entries.push([
        path.relative(out, file).split(path.sep).join('/'),
        sha(fs.readFileSync(file)),
      ]);
  }
}
inventory(out);
fs.writeFileSync(
  path.join(out, 'FILES.sha256'),
  entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join(''),
);
console.log(
  JSON.stringify({
    name: identity.name,
    version: identity.version,
    coreBundleSha256: sha(bundle),
    extensionTools: (
      await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs')
    ).EXPERIENCE_TOOLS.length,
    configured: false,
    authorizationGate,
  }),
);
