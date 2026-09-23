import type { Request } from 'express';
import type { Router } from 'express';

import type { Sim2RealAuthPort } from '../../server/sim2real/sim2real-auth.js';
import { standaloneAuth } from '../../server/sim2real/standalone-adapters.js';
import {
  createStudioCookieAuth,
  studioCookieAuthConfigured,
} from '../../server/sim2real/studio-cookie-auth.js';
import {
  STUDIO_DIRECT_LOGOUT_PATH,
  STUDIO_DIRECT_SESSION_COOKIES,
} from '../../server/sim2real/studio-direct-relay.js';
import {
  createTrustedProxyAuth,
  trustedProxyAuthConfigured,
} from '../../server/sim2real/trusted-proxy-auth.js';
import {
  createUserCenterAuth,
  userCenterAuthConfigured,
  USER_CENTER_LOGIN_PATH,
} from '../../server/sim2real/user-center-auth.js';

/**
 * Studio SSO is an integration adapter, not a Sim2Real business dependency.
 * The standalone service can replace this file with an OIDC adapter when it is
 * extracted to its own repository, while preserving the same auth port.
 *
 * Four selectable modes via RDK_SIM2REAL_AUTH_MODE:
 *  - `user-center`: direct User Center SSO (OAuth2 authorization code +
 *    RS256/JWKS verification) — independent of the Studio product. See
 *    docs/decisions/D-006-user-center-direct-auth.md.
 *  - `studio-cookie` (default for the rdkstudio web-cloud deployment): decrypt
 *    the site-wide `rdk_sso_web_session` cookie issued by the Studio main
 *    shell, sharing `RDK_STUDIO_COOKIE_SECRET`. Users log in once at Studio
 *    (or through the local relay login route) and are authenticated here.
 *  - `trusted-proxy`: signed identity headers from a verified SSO gateway.
 *  - `standalone`: single-user, no identity inference (fail-closed).
 */
type AuthMode = 'studio-cookie' | 'trusted-proxy' | 'user-center' | 'standalone';

function resolveAuthMode(): AuthMode {
  const raw = String(process.env.RDK_SIM2REAL_AUTH_MODE ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'trusted-proxy') return 'trusted-proxy';
  if (raw === 'standalone') return 'standalone';
  if (raw === 'user-center') return 'user-center';
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
const userCenterAuth = createUserCenterAuth();

const activeAuth: Sim2RealAuthPort =
  authMode === 'trusted-proxy'
    ? trustedProxyAuth
    : authMode === 'user-center'
      ? userCenterAuthConfigured()
        ? userCenterAuth
        : standaloneAuth
      : authMode === 'studio-cookie' && studioCookieAuthConfigured()
        ? studioCookieAuth
        : standaloneAuth;

export function studioSsoAdapterConfigured(): boolean {
  if (authMode === 'trusted-proxy') return trustedProxyAuthConfigured();
  if (authMode === 'user-center') return userCenterAuthConfigured();
  if (authMode === 'studio-cookie') return studioCookieAuthConfigured();
  return false;
}

export function studioSsoAdapterMode():
  'standalone' | 'trusted-proxy' | 'user-center' | 'studio-cookie' {
  if (authMode === 'user-center' && !userCenterAuthConfigured()) return 'standalone';
  return authMode === 'studio-cookie' && !studioCookieAuthConfigured() ? 'standalone' : authMode;
}

/**
 * user-center 模式的登录/回调/注销路由。必须在业务路由之前挂载：
 * login 回调设置的会话 cookie 由同步 resolvePrincipal 消费。
 */
export function registerAuthModeRoutes(router: Router): void {
  if (authMode === 'user-center' && userCenterAuthConfigured()) {
    userCenterAuth.registerRoutes(router);
  }
  if (authMode === 'studio-cookie' && studioCookieAuthConfigured()) {
    // Studio 会话 cookie 是本模式唯一的身份凭据，而 Studio 主壳没有服务端
    // 注销端点（会话本身无吊销机制）：退出 = 让浏览器不再携带这些 cookie，
    // 下一次请求即按未认证处理。三个名字 × 三条路径逐一失效，覆盖 Studio
    // 透传时可能携带的任意 Path 属性。
    const rawBase = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '')
      .trim()
      .replace(/\/+$/g, '');
    const base = rawBase && rawBase !== '/' ? `/${rawBase.replace(/^\/+/g, '')}` : '';
    const cookiePaths = [
      '/',
      '/api/sim2real/auth/studio-direct',
      ...(base ? [`${base}/api/sim2real/auth/studio-direct`] : []),
    ];
    const expired = STUDIO_DIRECT_SESSION_COOKIES.flatMap((name) =>
      cookiePaths.map(
        (path) =>
          `${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`,
      ),
    );
    router.get(STUDIO_DIRECT_LOGOUT_PATH, (_request, response) => {
      response.setHeader('set-cookie', expired);
      response.redirect(302, `${base}/login?loggedOut=1`);
    });
  }
}

/** 401 响应体下发的登录地址；无自有登录入口的模式返回 null。 */
export function ssoLoginUrlForDeployment(): string | null {
  if (authMode === 'user-center' && userCenterAuthConfigured()) return USER_CENTER_LOGIN_PATH;
  if (authMode === 'studio-cookie' && studioCookieAuthConfigured()) return '/login';
  return null;
}

export const studioSsoAuth: Sim2RealAuthPort = Object.freeze({
  isMultiUserDeployment: activeAuth.isMultiUserDeployment,
  resolvePrincipal: (request: Request) => activeAuth.resolvePrincipal(request),
  resolveAccessToken: (request: Request) => activeAuth.resolveAccessToken(request),
});
