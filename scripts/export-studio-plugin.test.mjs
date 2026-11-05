import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportStudioPlugin } from './export-studio-plugin.mjs';

test('native Studio export contains discoverable namespaced teaching skills and their references', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-studio-export-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'plugin');
  exportStudioPlugin({ output });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(output, '.rdstudio-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.skills, './skills');
  const qoder = JSON.parse(fs.readFileSync(path.join(output, '.qoder-plugin/plugin.json'), 'utf8'));
  assert.equal(qoder.name, manifest.name);
  assert.equal(qoder.version, manifest.version);
  assert.equal(qoder.mcpServers, './.mcp.json');
  assert.equal(qoder.skills, './skills');
  assert.ok(!('defaultEnabled' in qoder));
  const skills = fs.readdirSync(path.join(output, 'skills')).sort();
  assert.ok(skills.includes('rdk-platform-setup'));
  assert.ok(skills.includes('rdk-platform-training-runs'));
  assert.ok(skills.includes('rdk-platform-docs'));
  assert.ok(skills.includes('rdk-platform-experience-preparation'));
  assert.ok(fs.existsSync(path.join(output, 'scripts/experience.mjs')));
  assert.ok(fs.existsSync(path.join(output, 'scripts/start-mcp.mjs')));
  assert.ok(fs.existsSync(path.join(output, 'references/experience-profile.json')));
  const experience = fs.readFileSync(
    path.join(output, 'skills/rdk-platform-experience-preparation/SKILL.md'),
    'utf8',
  );
  assert.ok(experience.includes('../rdk-platform-setup/SKILL.md'));
  for (const match of experience.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(
      fs.existsSync(path.resolve(output, 'skills/rdk-platform-experience-preparation', match[1])),
    );
  }
  for (const name of skills) {
    const source = fs.readFileSync(path.join(output, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(source.includes(`name: ${name}\n`));
  }
  assert.ok(fs.existsSync(path.join(output, 'references', 'connection-contract.md')));
  const config = fs.readFileSync(path.join(output, '.mcp.json'), 'utf8');
  assert.ok(config.includes('start-studio-plugin-mcp.mjs'));
  assert.ok(!config.includes('studio-plugin-fixture=owner-a'));
  const readme = fs.readFileSync(path.join(output, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\((skills\/[^)]+)\)/g)) {
    assert.ok(
      fs.existsSync(path.join(output, match[1])),
      `Broken exported skill link: ${match[1]}`,
    );
  }
});
