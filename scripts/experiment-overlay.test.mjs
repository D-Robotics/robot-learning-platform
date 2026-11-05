import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { patchExperimentRoute } from './prepare-experiment-overlay.mjs';
const source =
  "import 'existing';\nfunction register(){\n    if (enforceMutationAccess(request, response, auth)) next();\n    registerSim2RealWorkspaceRoutes(router, {\n    });\n    retainExistingCourse();\n}\n";
const hash = (text) => createHash('sha256').update(text).digest('hex');
test('additive route patch preserves deployed course after the shared guard', () => {
  const result = patchExperimentRoute(source, hash(source));
  assert.match(result, /retainExistingCourse/);
  assert.equal(
    result
      .replace(
        "import { registerSim2RealExperimentRoutes } from './sim2real-experiment-routes.js';\n",
        '',
      )
      .replace(
        '    registerSim2RealExperimentRoutes(router, { requestOwner: (request, response) => requestOwner(request, response, auth) }, { prefix });\n',
        '',
      ),
    source,
  );
});
test('reject changed, duplicate, absent or unguarded deployed routes', () => {
  assert.throws(() => patchExperimentRoute(source + 'changed', hash(source)), /changed/);
  for (const bad of [
    source + source,
    source.replace('registerSim2RealWorkspaceRoutes', 'other'),
    source.replace('enforceMutationAccess', 'other'),
    source + 'registerSim2RealExperimentRoutes',
  ])
    assert.throws(() => patchExperimentRoute(bad, hash(bad)));
});
