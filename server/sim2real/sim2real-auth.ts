import type { Request } from 'express';

/**
 * Identity boundary owned by the standalone Sim2Real product.
 *
 * The business routes only need a stable account id and, for an explicit
 * RoboGo request, a short-lived server-side access token. They must not know
 * whether the caller arrived through Studio SSO, a native OIDC client, or a
 * future enterprise identity provider.
 */
export type Sim2RealPrincipal = {
  accountId: string;
  displayName?: string;
  email?: string;
};

export type Sim2RealAuthPort = {
  isMultiUserDeployment(): boolean;
  resolvePrincipal(request: Request): Sim2RealPrincipal | null;
  resolveAccessToken(request: Request): string | null;
};

/** Anonymous local-development adapter. It never grants a shared deployment a fallback owner. */
export const LOCAL_SIM2REAL_AUTH: Sim2RealAuthPort = Object.freeze({
  isMultiUserDeployment: () => false,
  resolvePrincipal: () => null,
  resolveAccessToken: () => null,
});
