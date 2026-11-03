#!/usr/bin/env node
/** Add host-neutral workflow tools to an independently verified portable MCP bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--base-plugin' || args[2] !== '--output')
  throw new Error(
    'Usage: node scripts/build-workflow-plugin.mjs --base-plugin <unconfigured portable plugin> --output <new-directory>',
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
]) {
  const bytes = fs.readFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/scripts', name),
  );
  fs.writeFileSync(path.join(out, 'scripts', name), bytes);
  sources['scripts/' + name] = sha(bytes);
}
fs.writeFileSync(
  path.join(out, 'scripts/start-core-mcp.mjs'),
  `import { main } from '../mcp/bundle.mjs';await main();\n`,
);
const configure = fs.readFileSync(path.join(out, 'configure.mjs'), 'utf8');
const original = "path.join(config.root,'mcp/bundle.mjs')";
if (!configure.includes(original))
  throw new Error('Unknown portable configure bootstrap; refusing an unchecked rewrite.');
fs.writeFileSync(
  path.join(out, 'configure.mjs'),
  configure.replace(original, "path.join(config.root,'scripts/experience-mcp.mjs')"),
);
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
const setup = path.join(out, 'skills/setup/SKILL.md');
fs.writeFileSync(
  setup,
  `---
name: robot-learning-setup
description: 连接当前机器人学习平台，确认正式身份与明确模型，再按真实工具能力执行训练与评测。
---

这是自包含便携插件，不需要平台源码或 npm install。先完成 configure.mjs 私人配置，再让宿主加载安装目录的 .mcp.json。每次先调用 rdk_platform_status，确认目标平台、正式身份和工具目录；导入版本不等于连接已切换。宿主存在旧的同类 MCP 连接时，更新那条连接的启动配置，不绕过认证或随意添加重复连接。

训练与评测先读 ../training-runs/SKILL.md。OriginMan 的登记材料在 ../../references/originman-manifest.json；使用真实原文，不补造 manifest。模型列表若只有 ID，读取明确任务的运行记录和对应血缘确认模型与契约，不按顺序猜、不误用 MicroDuck。不具备读取引用文件的宿主，应请用户选明确模型，不能假装已经读到文件。

以实际 tools/list 为准：预检接口缺失时保持未验证，不能声称环境已就绪；可用已支持的模型校验、资源测试和经授权的短训练验证。默认 GPU，CPU 必须显式选择；GPU不可用不自动降级。训练 device=cuda 不表示物理仿真也在 GPU。

提交成功保存 contextId 和原 Run；同源评测使用相同参数、sourceRunId 与独立幂等键。断线后恢复原引用，不自动重交。结果执行完成、效果门和真机资格分别报告。只有宿主实际打开且视频播放后才称回放通过。
`,
);

fs.appendFileSync(
  setup,
  '\n实验连续操作先读 ../training-runs/SKILL.md；提交后保存明确contextId，恢复原Run而不是重交。默认GPU，CPU必须显式选择。平台版本和引擎以实际工具回执为准。\n',
);
const identity = {
  name: 'rdk-robot-learning-platform',
  version: '0.1.14',
  description: '通用机器人学习工作流：实验接续、训练、评测、回放与失败诊断；GPU默认、CPU显式选择。',
};
fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify(identity, null, 2));
for (const directory of ['.rdstudio-plugin', '.codex-plugin']) {
  fs.mkdirSync(path.join(out, directory), { recursive: true });
  fs.writeFileSync(
    path.join(out, directory, 'plugin.json'),
    JSON.stringify(
      {
        ...identity,
        displayName: 'RDK Robot Learning Platform',
        mcpServers: './.mcp.json',
        skills: './skills',
        defaultEnabled: true,
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
      studioSourceModified: false,
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(out, 'README.md'),
  '# Robot Learning 工作流插件 0.1.14\n\n先在解压后的最终目录运行 `node configure.mjs --platform-url <平台地址>`，按原有方式配置私人认证，再在宿主导入实际配置。插件包自包含，无须平台源码或npm install。\n\n新增rdk_experiment_remember与rdk_experiment_resume：按平台、账号和明确contextId保存引用，每次恢复都查原Run，不自动重交或选择最新任务。不会自动同步另一台电脑；不把后台任务标为已停止，不自动打开页面或操作机器人。训练与评测仍使用原平台工具，平台继续执行权限和幂等校验。\n\n主线、状态与恢复操作见skills/training-runs/SKILL.md。能力验证范围以本轮交接记录为准。配置产生的私人文件不能再次分发。底层固定为已验证便携核心，来源见upstream-provenance.json，扩展源码摘要见provenance.json。\n',
);
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
    extensionTools: 2,
    configured: false,
  }),
);
