import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function embedUiAssets(template, css, source) {
  const script = source.replace(/<\/script/gi, '<\\/script');
  const shell = template
    .replace(/<link rel="stylesheet"[^>]+>/g, '')
    .replace(
      '<script type="module" src="./experiment-page.mjs"></script>',
      '__RDK_APP_BOOTSTRAP__',
    );
  if (/<(?:script|link)[^>]+(?:src|href)=/i.test(shell) || !shell.includes('__RDK_APP_BOOTSTRAP__'))
    throw Error('MCP App must contain no external scripts or stylesheets.');
  // A replacement string interprets SDK snippets such as $&, $` and $'.
  // A callback preserves the exact bundled program instead of rewriting it.
  const html = shell.replace(
    '__RDK_APP_BOOTSTRAP__',
    () => `<style>${css}</style><script type="module">${script}</script>`,
  );
  if (html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] !== script)
    throw Error('MCP App script changed during HTML embedding.');
  return html;
}
export async function buildPluginUi(output) {
  const privateModules = process.env.RDK_PLUGIN_UI_NODE_MODULES;
  const requireUi = createRequire(
    path.join(privateModules ? path.dirname(path.resolve(privateModules)) : root, 'package.json'),
  );
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['plugins/rdk-robot-learning-platform/ui/experiment-app.mjs'],
    nodePaths: privateModules ? [path.resolve(privateModules)] : [],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
    legalComments: 'inline',
  });
  const publicRoot = path.join(root, 'services/sim2real-web/public');
  const css = ['tokens.css', 'experiment.css']
    .map((name) => fs.readFileSync(path.join(publicRoot, name), 'utf8'))
    .join('\n');
  const html = embedUiAssets(
    fs.readFileSync(path.join(publicRoot, 'experiment.html'), 'utf8'),
    css,
    result.outputFiles[0].text,
  );
  fs.mkdirSync(path.join(output, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(output, 'ui/experiment.html'), html);
  const packages = [];
  for (const name of [
    '@modelcontextprotocol/ext-apps',
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/core',
    '@standard-schema/spec',
    'zod',
  ]) {
    let directory = path.dirname(
      requireUi.resolve(name === '@modelcontextprotocol/ext-apps' ? name + '/app-with-deps' : name),
    );
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name)
        break;
      directory = path.dirname(directory);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((file) =>
      fs.existsSync(path.join(directory, file)),
    );
    if (!license) throw Error('Missing bundled UI dependency license: ' + name);
    const target = path.join(
      output,
      'licenses',
      'mcp-ui',
      name.replace(/[^a-zA-Z0-9.-]/g, '_') + '-' + metadata.version,
    );
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(directory, license), path.join(target, 'LICENSE'));
    packages.push({ name, version: metadata.version, license: metadata.license });
  }
  fs.writeFileSync(path.join(output, 'ui/licenses.json'), JSON.stringify(packages, null, 2));
  const inputs = {};
  for (const file of [
    ...Object.keys(result.metafile.inputs),
    ...['tokens.css', 'experiment.css', 'experiment.html'].map((name) =>
      path.join(publicRoot, name),
    ),
  ]) {
    const absolute = path.resolve(root, file);
    const normalized = absolute.includes('/node_modules/')
      ? 'node_modules/' + absolute.split('/node_modules/').at(-1)
      : path.relative(root, absolute).split(path.sep).join('/');
    inputs[normalized] = sha(fs.readFileSync(absolute));
  }
  return {
    files: {
      'ui/experiment.html': sha(html),
      'ui/licenses.json': sha(fs.readFileSync(path.join(output, 'ui/licenses.json'))),
    },
    provenance: { bundler: 'esbuild', sdk: packages[0], inputs },
  };
}
