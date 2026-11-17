import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const {
  RDK_CLASSROOM_URL,
  RDK_CLASSROOM_TRAIN_RUN,
  RDK_CLASSROOM_EVAL_RUN,
  RDK_CLASSROOM_POLICY_SHA256,
  RDK_CLASSROOM_VIDEO_SHA256,
} = process.env;
if (
  ![RDK_CLASSROOM_URL, RDK_CLASSROOM_TRAIN_RUN, RDK_CLASSROOM_EVAL_RUN].every(Boolean) ||
  ![RDK_CLASSROOM_POLICY_SHA256, RDK_CLASSROOM_VIDEO_SHA256].every((value) =>
    /^[a-f0-9]{64}$/.test(value ?? ''),
  )
) {
  throw new Error(
    'Set the isolated classroom URL, both completed Run IDs, and expected policy/video SHA-256 values.',
  );
}
const root = new URL('api/v1/duck/', RDK_CLASSROOM_URL.replace(/\/?$/, '/'));
const sessionUrl = 'workshops/originman/sessions';
async function request(path, method = 'GET', payload) {
  const response = await fetch(new URL(path, root), {
    method,
    ...(payload
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
    signal: AbortSignal.timeout(40_000),
  });
  assert.ok(response.ok, `${method} ${path} returned HTTP ${response.status}`);
  return response;
}
const opened = await request(sessionUrl, 'POST', {
  sourceRunId: RDK_CLASSROOM_TRAIN_RUN,
  renderMode: 'webgl',
});
const session = await opened.json();
assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
const path = `${sessionUrl}/${session.sessionId}`;
try {
  assert.equal(session.sourceRunId, RDK_CLASSROOM_TRAIN_RUN);
  assert.equal(session.policySha256, RDK_CLASSROOM_POLICY_SHA256);
  assert.equal(session.controller, 'trained-rl');
  assert.equal(session.simulationOnly, true);
  assert.equal(session.jointCount, 20);
  await request(path + '/command', 'POST', { command: 'push', force: 4, delay: 0 });
  const step = await (
    await request(path + '/command', 'POST', { command: 'step', steps: 10 })
  ).json();
  assert.deepEqual(step.externalForceWorldN, [0, 4, 0]);
  assert.equal(step.policySha256, RDK_CLASSROOM_POLICY_SHA256);
  assert.ok(step.time > 0);
} finally {
  await request(path, 'DELETE');
}
const replay = await request(`runs/${encodeURIComponent(RDK_CLASSROOM_EVAL_RUN)}/workshop-video`);
assert.equal(replay.headers.get('content-type'), 'video/mp4');
assert.equal(replay.headers.get('X-Source-Artifact-Sha256'), RDK_CLASSROOM_VIDEO_SHA256);
const bytes = Buffer.from(await replay.arrayBuffer());
assert.equal(createHash('sha256').update(bytes).digest('hex'), RDK_CLASSROOM_VIDEO_SHA256);
console.log(
  '[originman-classroom] PASS — selected Run, original policy bytes, real MuJoCo perturbation and linked replay digest',
);
