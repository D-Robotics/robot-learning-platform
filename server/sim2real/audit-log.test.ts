import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listSim2RealAuditEvents,
  normalizeAuditEvent,
  recordSim2RealAudit,
  sim2RealAuditPath,
  sim2RealAuditHealth,
  flushSim2RealAudit,
  createSim2RealAuditMiddleware,
} from './audit-log.js';

const original = {
  dir: process.env.RDK_SIM2REAL_STORAGE_DIR,
  file: process.env.RDK_SIM2REAL_AUDIT_FILE,
};
const tempDirs: string[] = [];

afterEach(async () => {
  if (original.dir === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = original.dir;
  if (original.file === undefined) delete process.env.RDK_SIM2REAL_AUDIT_FILE;
  else process.env.RDK_SIM2REAL_AUDIT_FILE = original.file;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sim2real audit log', () => {
  it('normalizes privacy-sensitive fields and infers the outcome', () => {
    const event = normalizeAuditEvent({
      owner: 'alice\n',
      actor: { accountId: 'alice', displayName: 'Alice' },
      action: 'POST /api/runs',
      resourceType: 'runs',
      status: 403,
      outcome: undefined,
      details: {
        safe: 'ok',
        token: 'must-drop',
        nested: { secret: 'must-drop' },
      },
    });
    expect(event.outcome).toBe('denied');
    expect(event.owner).toBe('alice');
    expect(event.details).toEqual({ safe: 'ok' });
  });

  it('appends and filters owner-scoped events without exposing credentials', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    process.env.RDK_SIM2REAL_STORAGE_DIR = dir;
    delete process.env.RDK_SIM2REAL_AUDIT_FILE;
    recordSim2RealAudit({
      owner: 'alice',
      actor: { accountId: 'alice' },
      action: 'POST /api/runs',
      resourceType: 'runs',
      resourceId: 'run-1',
      status: 201,
      requestId: 'req-1',
      details: { modelId: 'model-1' },
    });
    recordSim2RealAudit({
      owner: 'bob',
      actor: { accountId: 'bob' },
      action: 'POST /api/runs',
      resourceType: 'runs',
      status: 500,
      details: { password: 'hidden' },
    });
    await flushSim2RealAudit();
    await readFile(sim2RealAuditPath(), 'utf8');
    const alice = await listSim2RealAuditEvents('alice');
    const bob = await listSim2RealAuditEvents('bob');
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({ owner: 'alice', outcome: 'succeeded', resourceId: 'run-1' });
    expect(bob).toHaveLength(1);
    expect(JSON.stringify(bob[0])).not.toContain('password');
  });

  it('fails health closed for a pre-created audit directory with broad permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    const auditDir = path.join(dir, 'audit');
    await mkdir(auditDir);
    await chmod(auditDir, 0o755);
    process.env.RDK_SIM2REAL_AUDIT_FILE = path.join(auditDir, 'audit.ndjson');

    const health = await sim2RealAuditHealth();
    expect(health).toMatchObject({ healthy: false, readable: false, writable: false });
    expect((await stat(auditDir)).mode & 0o7777).toBe(0o755);
  });

  it('repairs a pre-created audit file to owner-only permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'audit.ndjson');
    await writeFile(file, '', 'utf8');
    await chmod(file, 0o644);
    process.env.RDK_SIM2REAL_AUDIT_FILE = file;

    const initial = await sim2RealAuditHealth();
    expect(initial.readable).toBe(true);
    expect((await stat(file)).mode & 0o7777).toBe(0o600);

    recordSim2RealAudit({
      owner: 'alice',
      action: 'POST /api/probe',
      resourceType: 'probe',
      status: 200,
    });
    await flushSim2RealAudit();
    expect((await stat(file)).mode & 0o7777).toBe(0o600);
    expect((await sim2RealAuditHealth()).healthy).toBe(true);
  });

  it('fails health closed instead of following an audit file symlink', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    const target = path.join(dir, 'outside.ndjson');
    const file = path.join(dir, 'audit.ndjson');
    await writeFile(target, 'outside\n', 'utf8');
    await symlink(target, file);
    process.env.RDK_SIM2REAL_AUDIT_FILE = file;

    const health = await sim2RealAuditHealth();
    expect(health).toMatchObject({ healthy: false, readable: false, writable: false });
    expect(await readFile(target, 'utf8')).toBe('outside\n');
  });

  it('rejects a symlinked ancestor before recursive directory creation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    const outside = path.join(dir, 'outside');
    const link = path.join(dir, 'link');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, link);
    process.env.RDK_SIM2REAL_AUDIT_FILE = path.join(link, 'nested', 'audit.ndjson');

    const health = await sim2RealAuditHealth();
    expect(health).toMatchObject({ healthy: false, readable: false, writable: false });
    await expect(stat(path.join(outside, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records denied mutating responses even when auth or CSRF ends the request early', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-audit-'));
    tempDirs.push(dir);
    process.env.RDK_SIM2REAL_STORAGE_DIR = dir;
    delete process.env.RDK_SIM2REAL_AUDIT_FILE;

    const request = {
      method: 'POST',
      path: '/api/sim2real/runs',
      route: { path: '/api/sim2real/runs' },
      params: {},
    } as any;
    const response = new EventEmitter() as any;
    response.statusCode = 403;
    response.getHeader = () => 'request-denied-1';
    const next = () => undefined;
    const auth = {
      isMultiUserDeployment: () => true,
      resolvePrincipal: () => null,
    } as any;

    createSim2RealAuditMiddleware(auth)(request, response, next);
    response.emit('finish');
    await flushSim2RealAudit();

    const events = await listSim2RealAuditEvents(undefined, { limit: 10 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'POST /api/sim2real/runs',
          outcome: 'denied',
          status: 403,
          requestId: 'request-denied-1',
        }),
      ]),
    );
  });
});
