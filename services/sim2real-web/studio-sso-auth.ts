import type { Request } from 'express';

import type { Sim2RealAuthPort } from '../../server/sim2real/sim2real-auth.js';
import { standaloneAuth } from '../../server/sim2real/standalone-adapters.js';
import {
  createTrustedProxyAuth,
  trustedProxyAuthConfigured,
} from '../../server/sim2real/trusted-proxy-auth.js';

/**
 * Studio SSO is an integration adapter, not a Sim2Real business dependency.
 * The standalone service can replace this file with an OIDC adapter when it is
 * extracted to its own repository, while preserving the same auth port.
 */
const trustedProxyAuth = createTrustedProxyAuth();
const useTrustedProxy =
  String(process.env.RDK_SIM2REAL_AUTH_MODE ?? '').trim().toLowerCase() === 'trusted-proxy';
const activeAuth = useTrustedProxy ? trustedProxyAuth : standaloneAuth;

export function studioSsoAdapterConfigured(): boolean {
  return useTrustedProxy ? trustedProxyAuthConfigured() : false;
}

export function studioSsoAdapterMode(): 'standalone' | 'trusted-proxy' {
  return useTrustedProxy ? 'trusted-proxy' : 'standalone';
}

export const studioSsoAuth: Sim2RealAuthPort = Object.freeze({
  isMultiUserDeployment: activeAuth.isMultiUserDeployment,
  resolvePrincipal: (request: Request) => activeAuth.resolvePrincipal(request),
  resolveAccessToken: (request: Request) => activeAuth.resolveAccessToken(request),
});
