#!/usr/bin/env node
/** Add host-neutral workflow tools to an independently verified portable MCP bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPluginAuthRelease } from './verify-plugin-auth-release.mjs';
import { buildPluginUi } from './build-plugin-ui.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (
  ![4, 6].includes(args.length) ||
  args[0] !== '--base-plugin' ||
  args[2] !== '--output' ||
  (args.length === 6 && args[4] !== '--studio-login-patch')
)
  throw new Error(
    'Usage: node scripts/build-workflow-plugin.mjs --base-plugin <unconfigured portable plugin> --output <new-directory> [--studio-login-patch <host-patch.json>]',
  );
const base = path.resolve(args[1]),
  out = path.resolve(args[3]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(fs.readFileSync(path.join(base, 'provenance.json'), 'utf8'));
const coreProvenance = provenance.coreBundleSha256
  ? JSON.parse(fs.readFileSync(path.join(base, 'upstream-provenance.json'), 'utf8'))
  : provenance;
const bundle = fs.readFileSync(path.join(base, 'mcp/bundle.mjs'));
if (
  sha(bundle) !== coreProvenance.bundleSha256 ||
  (provenance.coreBundleSha256 && sha(bundle) !== provenance.coreBundleSha256)
)
  throw new Error('Base bundle does not match retained provenance.');
const baseConfig = fs.readFileSync(path.join(base, '.mcp.json'), 'utf8');
if (!baseConfig.includes('throw new Error') || baseConfig.includes('credentials-file'))
  throw new Error('Use an unconfigured distribution, never a privately configured installation.');
fs.mkdirSync(out, { recursive: false });
fs.cpSync(base, out, {
  recursive: true,
  dereference: false,
  filter: (file) => {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Base plugin contains symlink.');
    return !['.local', 'node_modules', '.DS_Store'].includes(path.basename(file));
  },
});
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
const sources = {};
for (const name of [
  'workshop-course.mjs',
  'workshop-entry.mjs',
  'development-targets.mjs',
  'playback-plan.mjs',
  'mcp-app-resource.mjs',
  'guided-input.mjs',
  'classroom-guide.mjs',
  'robot-onboarding.mjs',
  'qoder-install.mjs',
  'experience.mjs',
  'experience-mcp.mjs',
  'workflow-inspection.mjs',
  'experiment-context.mjs',
  'short-training.mjs',
  'plugin-auth.mjs',
  'authenticated-core.mjs',
  'plugin-errors.mjs',
  'course-setup.mjs',
  'originman-dance-config.mjs',
  'dance-training.mjs',
  'submission-journal.mjs',
  'install-host.mjs',
  'studio-login-patch.mjs',
]) {
  const bytes = fs.readFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/scripts', name),
  );
  fs.writeFileSync(path.join(out, 'scripts', name), bytes);
  sources['scripts/' + name] = sha(bytes);
}
const windowsBinding = fs.readFileSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/windows-binding.mjs'),
);
fs.writeFileSync(path.join(out, 'windows-binding.mjs'), windowsBinding);
sources['windows-binding.mjs'] = sha(windowsBinding);
const windowsSetup = fs.readFileSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/setup-windows.cmd'),
);
fs.writeFileSync(path.join(out, 'setup-windows.cmd'), windowsSetup);
sources['setup-windows.cmd'] = sha(windowsSetup);
fs.writeFileSync(
  path.join(out, 'scripts/start-core-mcp.mjs'),
  `import { main } from '../mcp/bundle.mjs';await main();\n`,
);
for (const name of [
  'configure.mjs',
  'setup.mjs',
  'setup-windows.ps1',
  'setup-macos.command',
  'setup-qoder-macos.command',
  'setup-qoder-windows.cmd',
  'runtime-downloads.json',
]) {
  const bytes = fs.readFileSync(path.join(root, 'plugins/rdk-robot-learning-platform', name));
  fs.writeFileSync(path.join(out, name), bytes);
  if (name.endsWith('.command')) fs.chmodSync(path.join(out, name), 0o755);
  sources[name] = sha(bytes);
}
fs.mkdirSync(path.join(out, 'references'), { recursive: true });
for (const name of ['experience-profile.json', 'experience-profile-microduck.json'])
  fs.copyFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/references', name),
    path.join(out, 'references', name),
  );
for (const name of ['experience-preparation', 'training-runs']) {
  fs.mkdirSync(path.join(out, 'skills', name), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform/skills', name, 'SKILL.md'),
    path.join(out, 'skills', name, 'SKILL.md'),
  );
}
// Preserve all relative skill/reference links, without adding local configuration.
fs.cpSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/references'),
  path.join(out, 'references'),
  { recursive: true },
);
fs.cpSync(path.join(root, 'plugins/rdk-robot-learning-platform/skills'), path.join(out, 'skills'), {
  recursive: true,
});
if (args[5]) {
  const bytes = fs.readFileSync(path.resolve(args[5]));
  const patch = JSON.parse(bytes);
  if (!patch.files || !Object.keys(patch.files).length) throw Error('Studio login patch is empty.');
  fs.mkdirSync(path.join(out, 'host'), { recursive: true });
  fs.writeFileSync(path.join(out, 'host', 'host-patch.json'), bytes);
  sources['host/host-patch.json'] = sha(bytes);
}
const uiBuild = await buildPluginUi(out);
Object.assign(sources, uiBuild.files);
const identity = {
  name: 'rdk-robot-learning-platform',
  version: JSON.parse(
    fs.readFileSync(path.join(root, 'plugins/rdk-robot-learning-platform/plugin.json'), 'utf8'),
  ).version,
  description:
    '一句话开始 Workshop：OriginMan 舞蹈 PPO 独立训练、Run 可视化直达、跨软件接续、曲线对比与仿真回放。',
};
fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify(identity, null, 2));
for (const directory of ['.rdstudio-plugin', '.codex-plugin', '.qoder-plugin']) {
  fs.mkdirSync(path.join(out, directory), { recursive: true });
  fs.writeFileSync(
    path.join(out, directory, 'plugin.json'),
    JSON.stringify(
      {
        ...identity,
        displayName: 'RDK Robot Learning Platform',
        mcpServers: './.mcp.json',
        skills: './skills',
        ...(directory === '.qoder-plugin' ? {} : { defaultEnabled: true }),
      },
      null,
      2,
    ),
  );
}
fs.writeFileSync(
  path.join(out, 'upstream-provenance.json'),
  JSON.stringify(coreProvenance, null, 2),
);
fs.writeFileSync(
  path.join(out, 'provenance.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      ...identity,
      composition: 'retained-core-with-host-neutral-workflow-extension',
      coreBundleSha256: sha(bundle),
      coreVersion: coreProvenance.version,
      wrapperSources: sources,
      uiBuild: uiBuild.provenance,
      studioHostPatchIncluded: Boolean(args[5]),
    },
    null,
    2,
  ),
);
fs.copyFileSync(
  path.join(root, 'plugins/rdk-robot-learning-platform/README.md'),
  path.join(out, 'README.md'),
);
for (const name of [
  'retained-workflow-provenance.json',
  'retained-workflow-044-provenance.json',
  'THIRD_PARTY_NOTICES.md',
]) {
  fs.copyFileSync(
    path.join(root, 'plugins/rdk-robot-learning-platform', name),
    path.join(out, name),
  );
}
const windowsResultFile = path.join(out, 'WINDOWS_RESULT_TEMPLATE.json');
if (fs.existsSync(windowsResultFile)) {
  const template = JSON.parse(fs.readFileSync(windowsResultFile, 'utf8'));
  template.candidateVersion = identity.version;
  fs.writeFileSync(windowsResultFile, JSON.stringify(template, null, 2) + '\n');
}
const authorizationGate = verifyPluginAuthRelease(out);
const entries = [];
function inventory(directory) {
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (entry.isFile() && file !== path.join(out, 'FILES.sha256'))
      entries.push([
        path.relative(out, file).split(path.sep).join('/'),
        sha(fs.readFileSync(file)),
      ]);
  }
}
inventory(out);
fs.writeFileSync(
  path.join(out, 'FILES.sha256'),
  entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join(''),
);
console.log(
  JSON.stringify({
    name: identity.name,
    version: identity.version,
    coreBundleSha256: sha(bundle),
    extensionTools: (
      await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs')
    ).EXPERIENCE_TOOLS.length,
    configured: false,
    authorizationGate,
  }),
);
