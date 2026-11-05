/** Add Workshop modules to a freshly reviewed deployed route; preserve its existing engine code. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function patchWorkshopRoute(source, expected) {
  const hash = createHash('sha256').update(source).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || hash !== expected)
    throw Error('Deployed route changed; review a fresh snapshot.');
  if (source.includes('registerSim2RealWorkshopRoutes'))
    throw Error('Workshop routes already installed.');
  const anchor = '    registerSim2RealExperimentRoutes(router,';
  if (source.split(anchor).length !== 2) throw Error('Expected one experiment registration.');
  if (
    source.indexOf('if (enforceMutationAccess(request, response, auth))') < 0 ||
    source.indexOf('if (enforceMutationAccess(request, response, auth))') > source.indexOf(anchor)
  )
    throw Error('Shared access guard must precede Workshop routes.');
  return (
    "import { registerSim2RealWorkshopRoutes } from './sim2real-workshop-routes.js';\n" +
    source.replace(
      anchor,
      '    registerSim2RealWorkshopRoutes(router, { requestOwner: (request, response) => requestOwner(request, response, auth) }, { prefix });\n' +
        anchor,
    )
  );
}
export async function prepareWorkshopOverlay({ route, expected, output, root = process.cwd() }) {
  await fs.mkdir(output, { recursive: false });
  const files = {};
  const entries = [
    'dist-server/server/routes/sim2real-workshop-routes.js',
    'dist-server/server/sim2real/workshop-session.js',
    'dist-server/server/sim2real/experiment-sessions.js',
    ...[
      'workshop.html',
      'workshop.css',
      'workshop-page.mjs',
      'experiment.html',
      'experiment.css',
      'experiment-view.mjs',
      'experiment-page.mjs',
    ].map((n) => 'services/sim2real-web/public/' + n),
  ];
  for (const name of entries) {
    const bytes = await fs.readFile(path.join(root, name));
    const dest = name.startsWith('services/') ? 'dist-server/' + name : name;
    await fs.mkdir(path.dirname(path.join(output, dest)), { recursive: true });
    await fs.writeFile(path.join(output, dest), bytes);
    files[dest] = createHash('sha256').update(bytes).digest('hex');
  }
  const name = 'dist-server/server/routes/sim2real-routes.js',
    patched = patchWorkshopRoute(await fs.readFile(route, 'utf8'), expected);
  await fs.writeFile(path.join(output, name), patched);
  files[name] = createHash('sha256').update(patched).digest('hex');
  await fs.writeFile(
    path.join(output, 'overlay-manifest.json'),
    JSON.stringify({ expectedRoute: expected, files }, null, 2),
  );
  return files;
}
