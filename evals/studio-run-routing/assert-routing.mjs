import assert from 'node:assert/strict';

const expectedTool = 'rdk_training_status';
const allowedAuxiliaryTools = new Set(['load_tools', 'load_skill', 'studio_open_url']);
const shortName = (name) => String(name).split('__').at(-1);

export default function assertRouting(output, { vars }) {
  try {
    const receipt = typeof output === 'string' ? JSON.parse(output) : output;
    const { runId, base, turns } = receipt;
    assert.equal(runId, vars.runId);
    assert.equal(turns.length, 2);
    const artifactPath = '/api/v1/duck/runs/' + runId + '/artifact';
    const link = new URL(artifactPath, base).href;
    const sessions = new Set();

    for (const [index, { events, requests }] of turns.entries()) {
      const turn = `turn ${index + 1}`;
      const meta = events.find(({ type }) => type === 'meta');
      assert.ok(meta?.data.sessionId, `${turn}: missing Studio session`);
      sessions.add(meta.data.sessionId);
      const errors = events.filter(({ type }) => type === 'error');
      assert.equal(errors.length, 0, `${turn}: ${errors[0]?.data?.message ?? 'Studio error'}`);
      const starts = events.filter(({ type }) => type === 'tool_start');
      const chosen = starts.filter(
        ({ data }) => !allowedAuxiliaryTools.has(shortName(data.toolName)),
      );
      assert.deepEqual(
        chosen.map(({ data }) => shortName(data.toolName)),
        [expectedTool],
        `${turn}: wrong tool sequence`,
      );
      const { toolCallId, args } = chosen[0].data;
      assert.equal(args?.runId, runId, `${turn}: wrong Run ID`);
      const result = events.find(
        ({ type, data }) => type === 'tool_result' && data.toolCallId === toolCallId,
      );
      assert.ok(result && !result.data.isError, `${turn}: tool did not return success`);
      const value = JSON.stringify(result.data.result);
      assert.ok(
        value.includes(link) && value.includes('retained'),
        `${turn}: missing verified link or retention receipt`,
      );
      assert.ok(
        requests.some(({ method, path }) => method === 'HEAD' && path === artifactPath),
        `${turn}: no artifact verification`,
      );
      assert.ok(
        requests.every(({ method }) => method === 'GET' || method === 'HEAD'),
        `${turn}: attempted mutation`,
      );
      const reply = events
        .filter(({ type }) => type === 'text')
        .map(({ data }) => data.delta ?? data.text)
        .join('');
      assert.ok(
        reply.includes(link) && /已留存|已经留存|已保留|已保存|retained/i.test(reply),
        `${turn}: reply omitted retention or download`,
      );
      assert.ok(
        events.some(({ type }) => type === 'done' || type === 'run_complete'),
        `${turn}: did not finish`,
      );
    }
    assert.equal(sessions.size, 1, 'The follow-up must use the same Studio session');
    return {
      pass: true,
      score: 1,
      reason: 'Both Studio turns queried and verified the same Run with no writes.',
    };
  } catch (error) {
    return { pass: false, score: 0, reason: error.message };
  }
}
