import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startScriptedModel({ historyOnly }) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { model, messages, tools = [] } = JSON.parse(Buffer.concat(chunks));
    const first = messages.find(({ role }) => role === 'user');
    const runId = String(first?.content).match(/\b[\da-f-]{36}\b/i)?.[0];
    const last = messages.at(-1);
    const advertised = tools.map((tool) => tool.function.name);
    const lookup = advertised.find((name) => name.endsWith('__rdk_training_status'));
    const text = String(last.content);
    const link = text.match(
      /http:\/\/127\.0\.0\.1:\d+\/api\/v1\/duck\/runs\/[\da-f-]+\/artifact/,
    )?.[0];
    const id = 'call_' + randomUUID().replaceAll('-', '');
    let delta;
    if (historyOnly && last.role === 'user') {
      delta = { content: '根据历史记录，策略已留存。' };
    } else if (last.role === 'tool' && link) {
      delta = { content: '平台已留存 ONNX 策略，下载链接为 ' + link };
    } else if (lookup && runId) {
      delta = toolCall(lookup, { runId });
    } else if (advertised.includes('load_tools') && last.role === 'user') {
      delta = toolCall('load_tools', {
        names: ['mcp__rdk-robot-learning-platform__rdk_training_status'],
      });
    } else {
      delta = { content: '本轮未能读取对应 Run。' };
    }

    function toolCall(name, args) {
      return {
        tool_calls: [
          { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      };
    }
    const send = (delta, finish_reason = null) => {
      const event = {
        id,
        model,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, delta, finish_reason }],
      };
      res.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant' });
    send(delta);
    send({}, delta.tool_calls ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  return {
    entry: {
      id: 'isolated-scripted-model',
      provider: 'openai-compatible',
      model: 'studio-run-test',
      apiKey: 'loopback-fixture',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
