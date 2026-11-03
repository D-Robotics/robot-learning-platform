import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { experimentContext } from '../plugins/rdk-robot-learning-platform/scripts/experiment-context.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-experiment-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    account: 'A',
    baseUrl: 'https://example.test/learning',
    status: 'running',
    source: 'train',
    sha: 'a'.repeat(64),
    fail: false,
  };
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'rdk_platform_status')
      return {
        ok: true,
        baseUrl: state.baseUrl,
        session: { authenticated: Boolean(state.account), accountId: state.account },
      };
    if (state.fail) throw Object.assign(new Error('Not found'), { httpStatus: 404 });
    const evaluation = args.runId === 'eval';
    return {
      runId: args.runId,
      modelId: 'model',
      status: evaluation ? 'completed' : state.status,
      summary: state.status === 'blocked' ? '先测试资源健康' : null,
      metrics: {
        originmanWorkshop: {
          phase: evaluation ? 'evaluate' : 'train',
          policySha256: state.sha,
          sourceRunId: evaluation ? state.source : null,
          clearGain: false,
          videoError: null,
        },
      },
    };
  };
  const tool = (operation, args) => experimentContext(operation, args, call, { directory });
  return { tool, state, calls, directory, call };
}
test('restores exact Run after creating a fresh plugin instance, without a submit', async (t) => {
  const f = fixture(t);
  await f.tool('remember', { contextId: 'lesson-1', runId: 'train' });
  f.state.status = 'completed';
  const r = await experimentContext('resume', { contextId: 'lesson-1' }, f.call, {
    directory: f.directory,
  });
  assert.equal(r.training.runId, 'train');
  assert.equal(r.training.status, 'completed');
  assert.equal(r.evaluation, null);
  assert.equal(r.execution.trainingSubmitted, false);
  assert.ok(f.calls.every((c) => ['rdk_platform_status', 'rdk_training_status'].includes(c.name)));
});
test('account and platform scopes never reuse another bookmark', async (t) => {
  const f = fixture(t);
  await f.tool('remember', { contextId: 'same', runId: 'train' });
  f.state.account = 'B';
  await assert.rejects(f.tool('resume', { contextId: 'same' }), /未保存/);
  f.state.account = 'A';
  f.state.baseUrl = 'https://other.test';
  await assert.rejects(f.tool('resume', { contextId: 'same' }), /未保存/);
});
test('a bookmark cannot silently switch to another training Run', async (t) => {
  const f = fixture(t);
  await f.tool('remember', { contextId: 'same', runId: 'train' });
  await assert.rejects(f.tool('remember', { contextId: 'same', runId: 'other' }), /其他训练/);
});
test('evaluation parent must match; no failed association is persisted', async (t) => {
  const f = fixture(t);
  f.state.source = 'foreign';
  await assert.rejects(
    f.tool('remember', { contextId: 'bad', runId: 'train', evaluationRunId: 'eval' }),
    /来源/,
  );
  await assert.rejects(f.tool('resume', { contextId: 'bad' }), /未保存/);
});
test('associated evaluation is read again and quality is separate from completion', async (t) => {
  const f = fixture(t);
  f.state.status = 'completed';
  const r = await f.tool('remember', {
    contextId: 'pair',
    runId: 'train',
    evaluationRunId: 'eval',
  });
  assert.equal(r.evaluation.runId, 'eval');
  assert.equal(r.quality.clearGain, false);
  assert.match(r.links.video, /\/api\/v1\/duck\/runs\/eval\/workshop-video$/);
  f.state.source = 'other';
  await assert.rejects(f.tool('resume', { contextId: 'pair' }), /来源/);
});
test('blocked explanations remain visible; pending training is not resubmitted', async (t) => {
  const f = fixture(t);
  f.state.status = 'blocked';
  const r = await f.tool('remember', { contextId: 'blocked', runId: 'train' });
  assert.equal(r.training.summary, '先测试资源健康');
  assert.match(r.nextAction, /原因/);
});
test('404 never falls back to a recent or globally successful Run', async (t) => {
  const f = fixture(t);
  await f.tool('remember', { contextId: 'missing', runId: 'train' });
  f.state.fail = true;
  await assert.rejects(f.tool('resume', { contextId: 'missing' }), /Not found/);
  assert.ok(
    f.calls.filter((c) => c.name === 'rdk_training_status').every((c) => c.args.runId === 'train'),
  );
});
test('no identity, path traversal and extra arguments fail closed', async (t) => {
  const f = fixture(t);
  f.state.account = '';
  await assert.rejects(f.tool('resume', { contextId: 'x' }), /身份/);
  f.state.account = 'A';
  await assert.rejects(f.tool('remember', { contextId: '../x', runId: 'train' }));
  await assert.rejects(f.tool('resume', { contextId: 'x', runId: 'train' }));
});
test('private bookmarks exclude raw account identity and reject symlink storage', async (t) => {
  const f = fixture(t);
  await f.tool('remember', { contextId: 'private', runId: 'train' });
  const file = fs.readdirSync(f.directory).find((n) => n.endsWith('.json'));
  assert.equal(fs.statSync(path.join(f.directory, file)).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(f.directory, file), 'utf8').includes('accountId'));
  fs.symlinkSync(f.directory, path.join(f.directory, 'link'));
  await assert.rejects(
    experimentContext('resume', { contextId: 'private' }, f.call, {
      directory: path.join(f.directory, 'link'),
    }),
    /目录/,
  );
});

test('queued evaluation can be saved from explicit requested parent, then must revalidate actual digest', async (t) => {
  const f = fixture(t);
  let completed = false;
  const call = async (name, args) => {
    if (name !== 'rdk_training_status' || args.runId !== 'eval') return f.call(name, args);
    return completed
      ? {
          runId: 'eval',
          modelId: 'model',
          status: 'completed',
          metrics: {
            originmanWorkshop: {
              phase: 'evaluate',
              sourceRunId: 'train',
              policySha256: 'b'.repeat(64),
            },
          },
        }
      : {
          runId: 'eval',
          modelId: 'model',
          status: 'queued',
          training: { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train' } },
        };
  };
  const r = await experimentContext(
    'remember',
    { contextId: 'pending', runId: 'train', evaluationRunId: 'eval' },
    call,
    { directory: f.directory },
  );
  assert.equal(r.association.executionVerified, false);
  assert.equal(r.evaluation.runId, 'eval');
  assert.equal(r.links.video, undefined);
  completed = true;
  await assert.rejects(
    experimentContext('resume', { contextId: 'pending' }, call, { directory: f.directory }),
    /摘要/,
  );
});
