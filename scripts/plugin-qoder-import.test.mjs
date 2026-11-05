import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQoderImportZip } from '../plugins/rdk-robot-learning-platform/scripts/qoder-install.mjs';
test('Qoder import retains self-contained UI and provenance, excluding local account caches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-import-'));
  try {
    fs.writeFileSync(
      path.join(root, 'plugin.json'),
      JSON.stringify({ name: 'rdk-robot-learning-platform', version: '0.5.0' }),
    );
    fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
    for (const name of ['ui', 'scripts', '.private']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'ui/experiment.html'), '<html>widget</html>');
    fs.writeFileSync(path.join(root, 'scripts/experience-mcp.mjs'), 'export {};');
    fs.writeFileSync(path.join(root, 'retained-workflow-044-provenance.json'), '{}');
    fs.writeFileSync(path.join(root, '.private/session.json'), 'SECRET_MUST_NOT_SHIP');
    createQoderImportZip(root);
    const bytes = fs.readFileSync(path.join(root, 'Qoder本机导入包.zip'));
    assert.ok(bytes.includes(Buffer.from('ui/experiment.html')));
    assert.ok(bytes.includes(Buffer.from('retained-workflow-044-provenance.json')));
    assert.ok(!bytes.includes(Buffer.from('SECRET_MUST_NOT_SHIP')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
