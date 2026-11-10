/** Produce a bounded retained-runtime overlay; never rewrite unrelated renderer code. */
import fs from 'node:fs';
import { recoveryVerdict } from '../services/sim2real-web/public/recovery-verdict.mjs';
export function patchRecoveryVerdict(source) {
  const lines = source.split('\n');
  const matching = lines.flatMap((line, index) =>
    line.includes("text('originman-verdict',") && line.includes('suite.originalRecovered')
      ? [index]
      : [],
  );
  if (matching.length !== 1)
    throw Error('Expected one legacy recovery summary; review the current renderer first.');
  lines[matching[0]] =
    `        text('originman-verdict', (${recoveryVerdict.toString()})(suite ? suite.cases : result.cases.map(c => ({...c, original:c.baseline, tuned:c.baseline})), referenceMode, suite ? suite.clearGain : result.clearGain, Boolean(suite)));`;
  return lines.join('\n');
}
if (process.argv[1]?.endsWith('patch-workbench-recovery-verdict.mjs')) {
  if (process.argv.length !== 4)
    throw Error('Usage: node scripts/patch-workbench-recovery-verdict.mjs INPUT OUTPUT');
  fs.writeFileSync(process.argv[3], patchRecoveryVerdict(fs.readFileSync(process.argv[2], 'utf8')));
}
