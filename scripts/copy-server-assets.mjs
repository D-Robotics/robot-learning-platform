/** Copy standalone runtime assets next to a compiled server output. */
import fs from 'node:fs';
import path from 'node:path';

function copyFile(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`[copy-server-assets] required file is missing: ${src}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(
    '[copy-server-assets]',
    path.relative(process.cwd(), src),
    '→',
    path.relative(process.cwd(), dst),
  );
}

const SKIP_DIR_NAMES = new Set(['_archive', '_template', 'node_modules', '.git', '__pycache__']);

function copyTreeFiltered(src, dst) {
  if (!fs.existsSync(src)) {
    throw new Error(`[copy-server-assets] required directory is missing: ${src}`);
  }
  const temporary = `${dst}.${process.pid}.${Date.now()}.tmp`;
  fs.rmSync(temporary, { recursive: true, force: true });
  function walk(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const source = path.join(from, name);
      const target = path.join(to, name);
      if (fs.statSync(source).isDirectory()) walk(source, target);
      else fs.copyFileSync(source, target);
    }
  }
  walk(src, temporary);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(temporary, dst);
  console.log(
    '[copy-server-assets]',
    path.relative(process.cwd(), src),
    '→',
    path.relative(process.cwd(), dst),
    '(dir, filtered)',
  );
}

// The standalone service only needs its browser assets. Keep this copier safe
// to run after an incremental build by replacing the destination atomically.
copyTreeFiltered(
  path.join('services', 'sim2real-web', 'public'),
  path.join('dist-server', 'services', 'sim2real-web', 'public'),
);

// The mock worker is a deliberate no-CUDA smoke dependency of the systemd
// example. TypeScript does not emit .mjs files, so copy it beside the compiled
// server instead of making the release unit depend on the source checkout.
copyFile(
  path.join('services', 'sim2real-web', 'mock-local-worker.mjs'),
  path.join('dist-server', 'services', 'sim2real-web', 'mock-local-worker.mjs'),
);

// The real local worker is a protocol bridge to an administrator-owned
// training engine. Copy it into the release so the systemd example can run
// without depending on the source checkout.
copyFile(
  path.join('services', 'sim2real-web', 'local-training-worker.mjs'),
  path.join('dist-server', 'services', 'sim2real-web', 'local-training-worker.mjs'),
);

copyFile(
  path.join('services', 'sim2real-web', 'local-board-agent.mjs'),
  path.join('dist-server', 'services', 'sim2real-web', 'local-board-agent.mjs'),
);

// Ship the dependency-free operational CLIs with a compiled release. They are
// intentionally kept beside the server output so an operator can run a
// post-deploy probe or a maintenance-window backup without a source checkout.
for (const file of [
  'verify-production-config.mjs',
  'verify-production-config.test.mjs',
  'probe-sim2real.mjs',
  'sim2real-storage-backup.mjs',
  'sim2real-nightly-backup.sh',
  'verify-storage-backup.mjs',
  'verify-service-probe.mjs',
]) {
  copyFile(path.join('scripts', file), path.join('dist-server', 'scripts', file));
}
copyFile(
  path.join('services', 'sim2real-web', 'sim2real.production.env.example'),
  path.join('dist-server', 'services', 'sim2real-web', 'sim2real.production.env.example'),
);

// The server embeds resolved task packs into runner payloads (robogo-runner
// imports scripts/resolve-task-pack.mjs), and that resolver reads tasks/ +
// adapters/ JSON. Ship all three so a dist deployment trains the declared
// task instead of silently degrading to engine defaults.
copyFile(
  path.join('scripts', 'resolve-task-pack.mjs'),
  path.join('dist-server', 'scripts', 'resolve-task-pack.mjs'),
);
// The resolver imports the reward vocabulary, so a dist deployment needs it too
// or every task resolution fails on a missing module.
copyFile(
  path.join('scripts', 'reward-vocabulary.mjs'),
  path.join('dist-server', 'scripts', 'reward-vocabulary.mjs'),
);
copyTreeFiltered(path.join('tasks'), path.join('dist-server', 'tasks'));
copyTreeFiltered(path.join('adapters'), path.join('dist-server', 'adapters'));
copyTreeFiltered(path.join('engines'), path.join('dist-server', 'engines'));
