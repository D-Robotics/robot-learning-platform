import type { Request } from 'express';

import type { Sim2RealAuthPort } from '../../server/sim2real/sim2real-auth.js';
import { standaloneAuth } from '../../server/sim2real/standalone-adapters.js';
import {
  createStudioCookieAuth,
  studioCookieAuthConfigured,
} from '../../server/sim2real/studio-cookie-auth.js';
import {
  createTrustedProxyAuth,
  trustedProxyAuthConfigured,
} from '../../server/sim2real/trusted-proxy-auth.js';

/**
 * Studio SSO is an integration adapter, not a Sim2Real business dependency.
 * The standalone service can replace this file with an OIDC adapter when it is
 * extracted to its own repository, while preserving the same auth port.
 *
 * Three selectable modes via RDK_SIM2REAL_AUTH_MODE:
 *  - `studio-cookie` (default for the rdkstudio web-cloud deployment): decrypt
 *    the site-wide `rdk_sso_web_session` cookie issued by the Studio main
 *    shell, sharing `RDK_STUDIO_COOKIE_SECRET`. Users log in once at Studio
 *    (or through the local relay login route) and are authenticated here.
 *  - `trusted-proxy`: signed identity headers from a verified SSO gateway.
 *  - `standalone`: single-user, no identity inference (fail-closed).
 */
type AuthMode = 'studio-cookie' | 'trusted-proxy' | 'standalone';

function resolveAuthMode(): AuthMode {
  const raw = String(process.env.RDK_SIM2REAL_AUTH_MODE ?? '').trim().toLowerCase();
  if (raw === 'trusted-proxy') return 'trusted-proxy';
  if (raw === 'standalone') return 'standalone';
  if (raw === 'studio-cookie') return 'studio-cookie';
  // Default: when the shared Studio cookie secret is present (the
  // web-cloud deployment loads it from the root-only env file), enable
  // cookie auth automatically. Otherwise keep the legacy fail-closed
  // standalone adapter so no deployment silently changes behaviour.
  return studioCookieAuthConfigured() ? 'studio-cookie' : 'standalone';
}

const authMode = resolveAuthMode();
const trustedProxyAuth = createTrustedProxyAuth();
const studioCookieAuth = createStudioCookieAuth();

const activeAuth: Sim2RealAuthPort =
  authMode === 'trusted-proxy'
    ? trustedProxyAuth
    : authMode === 'studio-cookie' && studioCookieAuthConfigured()
      ? studioCookieAuth
      : standaloneAuth;

export function studioSsoAdapterConfigured(): boolean {
  if (authMode === 'trusted-proxy') return trustedProxyAuthConfigured();
  if (authMode === 'studio-cookie') return studioCookieAuthConfigured();
  return false;
}

export function studioSsoAdapterMode(): 'standalone' | 'trusted-proxy' | 'studio-cookie' {
  return authMode === 'studio-cookie' && !studioCookieAuthConfigured()
    ? 'standalone'
    : authMode;
}

export const studioSsoAuth: Sim2RealAuthPort = Object.freeze({
  isMultiUserDeployment: activeAuth.isMultiUserDeployment,
  resolvePrincipal: (request: Request) => activeAuth.resolvePrincipal(request),
  resolveAccessToken: (request: Request) => activeAuth.resolveAccessToken(request),
});
