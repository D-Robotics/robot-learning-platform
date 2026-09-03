/** Copy standalone runtime assets next to a compiled server output. */
import fs from 'node:fs';
import path from 'node:path';

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return;
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
    console.warn('[copy-server-assets] skip tree: missing', path.relative(process.cwd(), src));
    return;
  }
  fs.rmSync(dst, { recursive: true, force: true });
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
  walk(src, dst);
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
  path.join('dist', 'services', 'sim2real-web', 'public'),
);
