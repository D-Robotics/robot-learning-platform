/**
 * Shared interpreter probe for the engine verify scripts.
 *
 * Six verify scripts carried their own copy of this loop with only the
 * candidate list and the import probe differing; one implementation keeps
 * interpreter detection identical across gates, so an environment-detection
 * fix moves every engine at once instead of six copies drifting.
 */
import { spawnSync } from 'node:child_process';

/** Ordered interpreter candidates shared by every engine gate (first hit wins). */
export const COMMON_PYTHON_CANDIDATES = [
  'python3',
  '/usr/bin/python3',
  '/opt/homebrew/bin/python3.12',
  '/opt/homebrew/bin/python3.11',
];

/**
 * First candidate whose runtime can `import probeImport`, or null.
 *
 * Probes run with stdio fully piped so a missing module prints nothing; the
 * caller owns the human-facing SKIP message.
 */
export function resolvePythonInterpreter(candidates, probeImport) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', probeImport], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}
