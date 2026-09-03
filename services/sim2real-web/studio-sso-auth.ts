import type { Request } from 'express';

import type { Sim2RealAuthPort } from '../../server/sim2real/sim2real-auth.js';
import { standaloneAuth } from '../../server/sim2real/standalone-adapters.js';

/**
 * Studio SSO is an integration adapter, not a Sim2Real business dependency.
 * The standalone service can replace this file with an OIDC adapter when it is
 * extracted to its own repository, while preserving the same auth port.
 */
export const studioSsoAuth: Sim2RealAuthPort = Object.freeze({
  isMultiUserDeployment: standaloneAuth.isMultiUserDeployment,
  resolvePrincipal: (request: Request) => standaloneAuth.resolvePrincipal(request),
  resolveAccessToken: (request: Request) => standaloneAuth.resolveAccessToken(request),
});
