import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const standalone = fs.readFileSync(path.join(root, 'services/sim2real-web/server.ts'), 'utf8');
const businessRoutes = fs.readFileSync(path.join(root, 'server/routes/sim2real-routes.ts'), 'utf8');
const copyAssets = fs.readFileSync(path.join(root, 'scripts/copy-server-assets.mjs'), 'utf8');
const boardAgent = fs.readFileSync(
  path.join(root, 'services/sim2real-web/local-board-agent.mjs'),
  'utf8',
);

assert.match(standalone, /export function createSim2RealWebApp/);
assert.match(standalone, /createSim2RealRouter\(\{ runOnDevice, auth: studioSsoAuth \}\)/);
assert.match(standalone, /studio-sso-auth/);
assert.match(standalone, /createDeviceBoardDetectRouter\(runOnDevice,\s*\{\s*auth:\s*studioSsoAuth\s*\}\)/);
assert.match(standalone, /express\.static\(PUBLIC_ROOT/);
assert.match(businessRoutes, /Sim2RealAuthPort/);
assert.doesNotMatch(businessRoutes, /from ['"]\.\.\/sso\.js['"]/);
assert.doesNotMatch(businessRoutes, /from ['"]\.\.\/studio-deployment\.js['"]/);
const adapters = fs.readFileSync(
  path.join(root, 'server/sim2real/standalone-adapters.ts'),
  'utf8',
);
assert.doesNotMatch(standalone, /from ['"].*server\/(?:sso|storage|agent-runtime)\.js['"]/);
assert.doesNotMatch(businessRoutes, /from ['"].*server\/(?:sso|storage|agent-runtime)\.js['"]/);
assert.match(adapters, /Never infer an identity from a client-controlled header/);
assert.match(copyAssets, /services.*sim2real-web.*public/);
assert.match(boardAgent, /actuatorControl: false/);
assert.match(boardAgent, /never executes shell|never opens SSH|never opens SSH/);
assert.match(boardAgent, /BOARD_AGENT_READ_ONLY/);
const stationRoutes = fs.readFileSync(
  path.join(root, 'server/routes/sim2real-board-station-routes.ts'),
  'utf8',
);
const stationProxy = fs.readFileSync(
  path.join(root, 'server/sim2real/board-station-proxy.ts'),
  'utf8',
);
assert.match(businessRoutes, /registerSim2RealBoardStationRoutes/, 'business router must mount the board-station proxy');
assert.match(stationRoutes, /SIM2REAL_BOARD_AGENT_NOT_CONFIGURED/, 'station proxy must fail closed when no agent is configured');
assert.match(stationRoutes, /SIM2REAL_STATION_COMMAND_REJECTED/, 'station commands must be whitelisted before dispatch');
assert.match(stationRoutes, /requestOwner/, 'station proxy must authenticate and scope by owner');
assert.match(stationProxy, /boardAgentUrl\(\)/, 'station proxy must reuse the SSRF-safe agent URL resolver');
assert.match(stationProxy, /redirect: 'error'/, 'station proxy must not follow redirects');
assert.match(stationProxy, /studioBridgeAgentJson/, 'shared Studio deployments must reuse the Local Bridge adapter');
assert.match(stationProxy, /cookie: options\.cookieHeader/, 'only the browser request cookie may authorize Studio bridge access');
console.log('[sim2real-web wiring] PASS — standalone and Studio-bridge surfaces are isolated by explicit adapters');
