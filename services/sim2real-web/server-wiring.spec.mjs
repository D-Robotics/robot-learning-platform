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

// Web-managed device connections (RDK Studio 网页版-style 添加设备) must keep
// the SSRF boundary: tunnels are loopback-only, owned by the server process,
// and the config proxy targets the connection's own tunnel URL.
const tunnelManager = fs.readFileSync(
  path.join(root, 'server/sim2real/board-tunnel-manager.ts'),
  'utf8',
);
assert.match(tunnelManager, /http:\/\/127\.0\.0\.1/, 'tunnel URLs must be loopback literals');
assert.match(tunnelManager, /BatchMode=yes/, 'tunnel ssh must be non-interactive (no passwords in the web layer)');
assert.match(tunnelManager, /ExitOnForwardFailure=yes/, 'failed forwards must kill the tunnel, not half-open');
const connectionRoutes = fs.readFileSync(
  path.join(root, 'server/routes/sim2real-device-connection-routes.ts'),
  'utf8',
);
assert.match(connectionRoutes, /baseUrl: url/, 'config proxy must target the connection\'s own tunnel, not the global agent URL');
assert.match(connectionRoutes, /RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE/, 'only the two documented board switches may be flipped');
assert.match(stationRoutes, /SIM2REAL_STATION_SWITCH_CONFIRM_REQUIRED/, 'turning motion ON must require an in-band confirm flag');
assert.match(stationRoutes, /stationSwitchEnabled/, 'drive/policy gates must read the runtime override surface');
const stationApp = fs.readFileSync(path.join(root, 'services/sim2real-web/public/app.js'), 'utf8');
assert.match(stationApp, /device-connections/, 'the station UI must call the device-connection surface');
assert.match(stationApp, /board-station\/switches/, 'the station UI must read the platform switch state');

console.log('[sim2real-web wiring] PASS — standalone and Studio-bridge surfaces are isolated by explicit adapters');
