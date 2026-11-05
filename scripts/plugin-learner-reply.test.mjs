import test from 'node:test';
import assert from 'node:assert/strict';
import {
  experimentStudentReply,
  experimentModelResult,
} from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
const record = {
  training: { status: 'completed', runId: 'PRIVATE-RUN' },
  evaluation: { status: 'completed' },
  association: { executionVerified: true },
  quality: { clearGain: false },
  links: { experiment: 'https://example.com/experiment.html?context=owned' },
};
test('normal result stays concise and does not leak diagnostics or claim playback', () => {
  const reply = experimentStudentReply(record);
  assert.ok(reply.length < 140);
  assert.match(reply, /未达到收益判据/);
  assert.match(reply, /experiment.html/);
  assert.doesNotMatch(reply, /PRIVATE-RUN|已播放|已提升|真机通过/);
  assert.equal(experimentStudentReply({ experiment: record }), reply);
});
test('failed, unknown and pending tasks never become a successful result', () => {
  assert.match(
    experimentStudentReply({ ...record, association: { executionVerified: false } }),
    /来源尚待核对/,
  );
  assert.match(experimentStudentReply({ ...record, evaluation: { status: 'failed' } }), /未成功/);
  assert.match(
    experimentStudentReply({ ...record, evaluation: { status: 'running' } }),
    /正在评测/,
  );
  assert.match(
    experimentStudentReply({ ...record, training: { status: 'running' } }),
    /训练进行中/,
  );
  assert.match(experimentStudentReply({ ...record, stopWorkflow: true }), /暂停/);
  assert.match(experimentStudentReply({ ...record, quality: {} }), /效果尚待验证/);
  assert.equal(experimentStudentReply({}), null);
});

test('text-only model view keeps precise references without duplicating the raw run diagnostics', () => {
  const payload = {
    ...record,
    contextId: 'owned',
    studentReply: '结果已读取',
    training: { ...record.training, metrics: { largeDiagnostic: [1, 2, 3] } },
  };
  const result = experimentModelResult(payload);
  assert.equal(result.contextId, 'owned');
  assert.equal(result.training.runId, 'PRIVATE-RUN');
  assert.equal(result.training.status, 'completed');
  assert.equal(result.quality.clearGain, false);
  assert.equal(result.training.metrics, undefined);
  assert.deepEqual(payload.training.metrics, { largeDiagnostic: [1, 2, 3] });
  assert.equal(result.playback.verifiedInPlayer, false);
});
