import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createSim2RealWebApp } from '../services/sim2real-web/server.ts';
import { flushSim2RealAudit } from '../server/sim2real/audit-log.ts';
import { main } from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

test('plugin CLI talks to actual MCP and isolated platform without creating runs', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-experience-'));
  const oldEnv = { ...process.env };
  let server;
  try {
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(scratch, 'ledger');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
    delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
    delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    for (const key of ['COOKIE', 'USERNAME', 'PASSWORD'])
      delete process.env[`RDK_SIM2REAL_MCP_${key}`];
    server = createSim2RealWebApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.RDK_SIM2REAL_MCP_BASE_URL = base;
    process.env.RDK_ROBOT_LEARNING_PLATFORM_ROOT = process.cwd();
    process.env.RDK_ROBOT_LEARNING_PLATFORM_CONFIG = path.join(scratch, 'missing.json');
    process.env.RDK_ROBOT_LEARNING_PLATFORM_NODE = process.execPath;
    const profile = 'plugins/rdk-robot-learning-platform/references/experience-profile.json';
    const before = await (await fetch(`${base}/api/v1/duck/runs`)).json();
    const result = await main(['prepare', profile]);
    // Preparing an OriginMan entry is read-only; it does not claim an executor exists.
    // Missing optional MicroDuck browser assets must not select or block this product.
    assert.equal(result.status, 'prepared');
    assert.ok(result.entryUrl.includes('robot=originman'));
    if (result.status === 'prepared') {
      assert.ok(result.entryUrl.startsWith(base));
      assert.ok(Object.values(result.execution).every((x) => x === false));
    } else assert.ok(result.checks.some((c) => c.status === 'blocked'));
    const after = await (await fetch(`${base}/api/v1/duck/runs`)).json();
    assert.deepEqual(after, before);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await flushSim2RealAudit();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
