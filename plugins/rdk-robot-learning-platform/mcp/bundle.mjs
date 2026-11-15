#!/usr/bin/env node
import { assertSupportedNode } from '../runtime-guard.mjs';
import { isDirectInvocation } from '../scripts/experience.mjs';

export async function main() {
  assertSupportedNode();
  const core = await import('./retained-core.mjs');
  return core.main();
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
