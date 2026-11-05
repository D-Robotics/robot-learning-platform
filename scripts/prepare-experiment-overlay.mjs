/** Prepare an additive overlay against an explicitly pinned deployed release. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function patchExperimentRoute(source, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha(source) !== expectedSha256)
    throw Error('Deployed route changed; obtain and review a fresh snapshot.');
  if (source.includes('registerSim2RealExperimentRoutes'))
    throw Error('Experiment routes already installed.');
  const anchor = '    registerSim2RealWorkspaceRoutes(router, {';
  if (source.split(anchor).length !== 2) throw Error('Workspace registration must be unique.');
  const guard = source.indexOf('if (enforceMutationAccess(request, response, auth))');
  if (guard < 0 || guard > source.indexOf(anchor))
    throw Error('Shared access guard must precede registration.');
  return (
    "import { registerSim2RealExperimentRoutes } from './sim2real-experiment-routes.js';\n" +
    source.replace(
      anchor,
      '    registerSim2RealExperimentRoutes(router, { requestOwner: (request, response) => requestOwner(request, response, auth) }, { prefix });\n' +
        anchor,
    )
  );
}
export async function prepareOverlay({ route, expectedSha256, output, root = process.cwd() }) {
  await fs.mkdir(output, { recursive: false });
  const files = [
    'dist-server/server/routes/sim2real-experiment-routes.js',
    'dist-server/server/sim2real/experiment-sessions.js',
    ...['experiment.html', 'experiment.css', 'experiment-view.mjs', 'experiment-page.mjs'].map(
      (name) => 'services/sim2real-web/public/' + name,
    ),
  ];
  const records = {};
  for (const name of files) {
    const bytes = await fs.readFile(path.join(root, name));
    const destination = name.startsWith('services/') ? 'dist-server/' + name : name;
    await fs.mkdir(path.dirname(path.join(output, destination)), { recursive: true });
    await fs.writeFile(path.join(output, destination), bytes);
    records[destination] = sha(bytes);
  }
  const name = 'dist-server/server/routes/sim2real-routes.js';
  const patched = patchExperimentRoute(await fs.readFile(route, 'utf8'), expectedSha256);
  await fs.writeFile(path.join(output, name), patched);
  records[name] = sha(patched);
  const manifest = { schemaVersion: 1, baseRouteSha256: expectedSha256, files: records };
  await fs.writeFile(
    path.join(output, 'overlay-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [route, expectedSha256, output] = process.argv.slice(2);
  if (!route || !expectedSha256 || !output)
    throw Error(
      'Usage: prepare-experiment-overlay <route snapshot> <sha256> <new output directory>',
    );
  console.log(JSON.stringify(await prepareOverlay({ route, expectedSha256, output })));
}
