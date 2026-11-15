import { readFileSync } from 'node:fs';

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
export function assertSupportedNode(
  version = process.versions.node,
  range = JSON.parse(readFileSync(new URL('./runtime-requirements.json', import.meta.url), 'utf8'))
    .node,
) {
  if (!supportedNode(version, range))
    throw Error(
      `当前 Node ${version} 不符合插件运行要求 ${range}。请运行本系统的 setup 安装入口，或使用符合要求的 Node 启动插件。`,
    );
}
