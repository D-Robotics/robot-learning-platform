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
          video: evaluation ? state.video : undefined,
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
  f.state.video = { sha256: 'c'.repeat(64), bytes: 1024 };
  const r = await f.tool('remember', {
    contextId: 'pair',
    runId: 'train',
    evaluationRunId: 'eval',
  });
  assert.equal(r.evaluation.runId, 'eval');
  assert.equal(r.quality.clearGain, false);
  assert.equal(r.playback.state, 'recorded');
  assert.equal(r.playback.endpointVerified, false);
  assert.match(r.links.video, /\/api\/v1\/duck\/runs\/eval\/workshop-video\?format=webm$/);
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

test('failed evaluation without a digest preserves its actual failure and original log target', async (t) => {
  const f = fixture(t);
  f.state.status = 'completed';
  let status = 'queued';
  const call = async (name, args) => {
    if (name !== 'rdk_training_status' || args.runId !== 'eval') return f.call(name, args);
    return {
      runId: 'eval',
      modelId: 'model',
      status,
      summary: 'GPU Worker disconnected',
      training: { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train' } },
    };
  };
  await experimentContext(
    'remember',
    { contextId: 'worker-lost', runId: 'train', evaluationRunId: 'eval' },
    call,
    { directory: f.directory },
  );
  for (status of ['failed', 'blocked', 'cancelled']) {
    const r = await experimentContext('resume', { contextId: 'worker-lost' }, call, {
      directory: f.directory,
    });
    assert.equal(r.evaluation.status, status);
    assert.equal(r.evaluation.summary, 'GPU Worker disconnected');
    assert.equal(r.association.executionVerified, false);
    assert.equal(r.quality.clearGain, null);
    assert.equal(r.links.video, undefined);
    assert.equal(r.suggestedRead.arguments.runId, 'eval');
    assert.match(r.nextAction, /评测.*日志/);
    assert.doesNotMatch(r.nextAction, /继续查询/);
  }
});

test('completed evaluation without a video receipt never advertises a playable link', async (t) => {
  const f = fixture(t);
  f.state.status = 'completed';
  const r = await f.tool('remember', {
    contextId: 'no-video',
    runId: 'train',
    evaluationRunId: 'eval',
  });
  assert.equal(r.links.video, undefined);
  assert.equal(r.playback.state, 'missing');
  assert.match(r.nextAction, /视频/);
});

test('contradictory evaluation parent declarations are rejected', async (t) => {
  const f = fixture(t);
  const call = async (name, args) => {
    const r = await f.call(name, args);
    if (args?.runId === 'eval')
      r.training = { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'foreign' } };
    return r;
  };
  await assert.rejects(
    experimentContext(
      'remember',
      { contextId: 'contradictory', runId: 'train', evaluationRunId: 'eval' },
      call,
      { directory: f.directory },
    ),
    /来源/,
  );
});

test('identity changes during Run reads do not persist or return an experiment', async (t) => {
  const f = fixture(t);
  const call = async (name, args) => {
    const r = await f.call(name, args);
    if (name === 'rdk_training_status') f.state.account = 'B';
    return r;
  };
  await assert.rejects(
    experimentContext('remember', { contextId: 'switch', runId: 'train' }, call, {
      directory: f.directory,
    }),
    /身份.*变化/,
  );
  assert.equal(fs.readdirSync(f.directory).length, 0);
});

test('actual stdio wrapper returns a failed evaluation as diagnostic data and remains usable after rejection', async (t) => {
  const { connectMcp, readToolResult } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience.mjs');
  const f = fixture(t);
  const moduleUrl = new URL(
    '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs',
    import.meta.url,
  ).href;
  const source = `
    import {createInterface} from 'node:readline';
    import {experienceProxy} from ${JSON.stringify(moduleUrl)};
    let failed=false;
    const proxy=experienceProxy({request:async(method,p={})=>{
      if(method==='initialize')return {serverInfo:{name:'fixture',version:'1'}};
      if(method==='tools/list')return {tools:[]};
      if(method==='fixture/fail'){failed=true;return {changed:true};}
      if(p.name==='rdk_platform_status')return {structuredContent:{ok:true,baseUrl:'https://example.test/learning',session:{authenticated:true,accountId:'A'}}};
      if(p.name!=='rdk_training_status')throw Error('Unexpected business operation');
      const evaluation=p.arguments.runId==='eval';
      return {structuredContent:evaluation?{runId:'eval',modelId:'model',status:failed?'failed':'queued',summary:failed?'Worker offline':null,training:{originmanWorkshop:{phase:'evaluate',sourceRunId:'train'}}}:{runId:p.arguments.runId,modelId:'model',status:'completed',metrics:{originmanWorkshop:{phase:'train',policySha256:'a'.repeat(64)}}}};
    }},{contextDirectory:${JSON.stringify(f.directory)}});
    createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);if(m.id==null)return;try{const result=await proxy(m.method,m.params);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));}catch(e){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}}));}});
  `;
  const client = connectMcp({ args: ['--input-type=module', '-e', source], timeoutMs: 3000 });
  try {
    const call = (name, args) => client.request('tools/call', { name, arguments: args });
    const saved = readToolResult(
      await call('rdk_experiment_remember', {
        contextId: 'stdio',
        runId: 'train',
        evaluationRunId: 'eval',
      }),
    );
    assert.equal(saved.evaluation.status, 'queued');
    await client.request('fixture/fail');
    const failed = readToolResult(await call('rdk_experiment_resume', { contextId: 'stdio' }));
    assert.equal(failed.evaluation.summary, 'Worker offline');
    assert.equal(failed.playback.state, 'blocked');
    const rejected = await call('rdk_experiment_remember', {
      contextId: 'stdio',
      runId: 'foreign',
    });
    assert.equal(rejected.isError, true);
    const recovered = readToolResult(await call('rdk_experiment_resume', { contextId: 'stdio' }));
    assert.equal(recovered.training.runId, 'train');
    assert.equal(recovered.evaluation.runId, 'eval');
    assert.equal(recovered.execution.trainingSubmitted, false);
  } finally {
    await client.close();
  }
});
