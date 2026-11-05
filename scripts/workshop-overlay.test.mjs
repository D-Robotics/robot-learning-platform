import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { patchWorkshopRoute } from './prepare-workshop-overlay.mjs';
test('incremental overlay binds exact deployed route and retains the shared authorization boundary', () => {
  const src =
    'if (enforceMutationAccess(request, response, auth)) {}\n    registerSim2RealExperimentRoutes(router, deps, options);\n';
  const hash = createHash('sha256').update(src).digest('hex');
  const out = patchWorkshopRoute(src, hash);
  assert.match(out, /registerSim2RealWorkshopRoutes/);
  assert.ok(
    out.indexOf('enforceMutationAccess(request') <
      out.indexOf('    registerSim2RealWorkshopRoutes(router'),
  );
  assert.throws(() => patchWorkshopRoute(src + 'changed', hash));
  assert.throws(() => patchWorkshopRoute(out, createHash('sha256').update(out).digest('hex')));
});
