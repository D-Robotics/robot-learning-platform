#!/usr/bin/env node
/**
 * Generate the plugin's MCP descriptors from the executable product catalog.
 * Run from the repository with a supported Node runtime:
 *   node --import tsx/esm scripts/update-platform-plugin-catalog.mjs [--check]
 * No platform requests are made. This constructs handlers without calling them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const args = process.argv.slice(2);
if (args.some((arg) => !['--check', '--help', '-h'].includes(arg))) {
  console.error(
    'Usage: node --import tsx/esm scripts/update-platform-plugin-catalog.mjs [--check]',
  );
  process.exitCode = 2;
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Generate the platform plugin tool-catalog.json and tool-catalog.md from Duck Lab MCP.',
  );
  console.log(
    '--check verifies current snapshots without changing files or contacting a platform.',
  );
} else {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const [{ buildToolCatalog }, { createDshCapabilityHandlers }] = await Promise.all([
    import('../services/duck-lab-mcp/server.ts'),
    import('../server/agent-runtime/dsh-capability-handlers.ts'),
  ]);
  const tools = buildToolCatalog(createDshCapabilityHandlers(), [
    {
      id: 'rdk_platform_status',
      description: '读取平台服务健康、就绪与当前会话身份',
      readOnly: true,
    },
  ]);
  const schemaText = (schema) => {
    if (schema.type === 'array') return `array<${schema.items?.type ?? 'unknown'}>`;
    return schema.type ?? 'any';
  };
  const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = tools.map((tool) => {
    const required = tool.inputSchema.required ?? [];
    const properties = Object.entries(tool.inputSchema.properties ?? {}).map(
      ([name, schema]) => `\`${name}${required.includes(name) ? '*' : ''}: ${schemaText(schema)}\``,
    );
    return `| \`${tool.name}\` | ${escapeCell(tool.description)} | ${tool.annotations.readOnlyHint ? 'true' : 'false'} | ${tool.annotations.destructiveHint ? 'true' : 'false'} | ${properties.join(', ') || '—'} |`;
  });
  const markdown = [
    '# MCP 工具目录（由仓库契约生成）',
    '',
    `当前同源目录共 ${tools.length} 个工具；JSON 全量 descriptor（含 schema/annotation）见 [tool-catalog.json](tool-catalog.json)。`,
    '',
    '生成真源：目标仓库 `server/agent-runtime/dsh-capability-tools.ts`、`dsh-capability-handlers.ts`、`services/duck-lab-mcp/server.ts`。在 `RDK_ROBOT_LEARNING_PLATFORM_ROOT` 执行：',
    '',
    '```bash',
    'node --import tsx/esm scripts/update-platform-plugin-catalog.mjs',
    'node --import tsx/esm scripts/update-platform-plugin-catalog.mjs --check',
    '```',
    '',
    '安装后以实际 `tools/list` 为准；插件验证对 JSON 快照与实际目录的 schema/annotation 做完整比较。生成不联系平台。',
    '',
    '## 输入和标注',
    '',
    '`*` 是 MCP schema.required 字段；schema 是类型提示，不替代 handler/API 的业务必填校验。所有工具允许额外字段，但 handler 不保证透传任意字段。',
    '',
    '已知 handler 额外条件：`rdk_device_connect` 需要 connectionId；`rdk_board_policy_start` 需要数值 direction；`rdk_board_arm_move` 需要数值 x/y/z（mm）；`rdk_board_arm_gripper` 需要 action=open|close 及正数 value。dataset_register 接受 sha256；policy_load 接受 artifactSha256；station 类工具接受可选 deviceId。',
    '',
    '`readOnlyHint` 是产品标注：preflight 可创建台账计划，evaluation_summarize 可刷新评测；不会因此运动。`destructiveHint` 也不等于所有物理动作，非只读动作仍遵守平台门禁和授权。稳定 idempotencyKey 通用参数由 MCP 接受，不能据此保证每个动作去重，详见 [连接契约](connection-contract.md)。',
    '',
    '| 工具 | 功能 | readOnlyHint | destructiveHint | schema 参数 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 工作流入口',
    '',
    '[训练/评测/部署](workflow-contracts.md) · [设备](device-contracts.md) · [API 能力](api-workflows.md) · [CLI/工作台](cli-capabilities.md) · [开发不变量](development-invariants.md)',
    '',
  ].join('\n');
  const prettierConfig = await resolveConfig(path.join(repoRoot, 'package.json'));
  const json = await format(JSON.stringify(tools), { ...prettierConfig, parser: 'json' });
  const outputs = [
    ['tool-catalog.json', json],
    ['tool-catalog.md', markdown],
  ];
  let mismatch = false;
  for (const [name, content] of outputs) {
    const destination = path.join(repoRoot, 'plugins/rdk-robot-learning-platform/references', name);
    if (args.includes('--check')) {
      const existing = await readFile(destination, 'utf8').catch(() => '');
      if (existing !== content) {
        mismatch = true;
        console.error(`${name} differs from the executable platform catalog; regenerate it.`);
      }
    } else {
      await writeFile(destination, content);
    }
  }
  if (mismatch) process.exitCode = 1;
  else
    console.log(
      `Platform plugin MCP catalog ${args.includes('--check') ? 'verified' : 'generated'}: ${tools.length} tools.`,
    );
}
