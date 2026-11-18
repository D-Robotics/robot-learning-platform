import { fileURLToPath } from 'node:url';
import { connectAuthenticatedCore } from '../../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs';
import { experienceProxy } from '../../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
import { connectMcp } from '../../plugins/rdk-robot-learning-platform/scripts/experience.mjs';
import {
  createJsonRpcDispatcher,
  serveStdio,
} from '../../dist-server/services/duck-lab-mcp/jsonrpc.js';

const audience = process.env.RDK_SIM2REAL_MCP_BASE_URL;
const endpoint = new URL(audience);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port)
  throw new Error('Fixture MCP only accepts an owned loopback endpoint.');

const core = await connectAuthenticatedCore({
  authentication: {
    audience,
    mode: 'fixture',
    cookie: async () => 'studio-run-eval=fixture-owner',
    status: async () => ({ authenticated: true, accountId: 'fixture-owner' }),
    invalidate: async () => {},
  },
  connect: (options) =>
    connectMcp({
      ...options,
      args: [
        fileURLToPath(
          new URL('../../dist-server/services/duck-lab-mcp/server.js', import.meta.url),
        ),
      ],
    }),
});
const dispatch = experienceProxy(core, { authentication: core.authentication });
const service = Object.fromEntries(
  ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].map((method) => [
    method,
    (params) => dispatch(method, params),
  ]),
);
serveStdio(createJsonRpcDispatcher(service));
process.stdin.once('end', () => void core.close());
process.once('SIGTERM', () => void core.close().finally(() => process.exit(0)));
