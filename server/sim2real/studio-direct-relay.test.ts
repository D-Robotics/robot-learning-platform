import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createStudioDirectRelay, renderStudioDirectLoginPage } from './studio-direct-relay.js';

const ENV_KEYS = [
  'RDK_STUDIO_COOKIE_SECRET',
  'RDK_SIM2REAL_STUDIO_ORIGIN',
  'RDK_SIM2REAL_AUTH_MODE',
];

let restoreEnv: () => void = () => undefined;

function setTestEnv(values: Record<string, string | undefined>): void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  restoreEnv = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => restoreEnv());

function studioResponse(options: {
  status?: number;
  setCookie?: string[];
  body?: Record<string, unknown>;
}): Response {
  const status = options.status ?? 200;
  const headers = new Headers();
  for (const cookie of options.setCookie ?? []) headers.append('set-cookie', cookie);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => options.body ?? {},
  } as unknown as Response;
}

function makeApp(
  post: (url: string, body: string) => Promise<Response>,
  mode: 'json' | 'form' = 'json',
): express.Express {
  const relay = createStudioDirectRelay({ post });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  if (mode === 'json') {
    app.post('/api/sim2real/auth/studio-direct/login', (req, res) => {
      void relay.handleJson(req, res);
    });
  } else {
    app.post('/api/sim2real/auth/studio-direct/login', (req, res) => {
      void relay.handleForm(req, res);
    });
  }
  app.get('/login', (_req, res) => {
    res.type('html').send(renderStudioDirectLoginPage('invalid'));
  });
  return app;
}

async function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

function configuredEnv(): Record<string, string> {
  return {
    RDK_STUDIO_COOKIE_SECRET: 'unit-test-cookie-secret-0123456789abcdef',
    RDK_SIM2REAL_STUDIO_ORIGIN: 'https://rdkstudio.example.test',
    RDK_SIM2REAL_AUTH_MODE: 'studio-cookie',
  };
}

describe('studio direct-login relay', () => {
  it('relays credentials and passes studio session cookies through', async () => {
    setTestEnv(configuredEnv());
    const bodies: string[] = [];
    const app = makeApp(async (url, body) => {
      bodies.push(`${url} ${body}`);
      return studioResponse({
        setCookie: ['rdk_sso_web_session=v1.a.b.c; Path=/; HttpOnly', 'other=skip-me'],
      });
    });
    const base = await listen(app);
    const response = await fetch(`${base}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'op-1', password: 'pw' }),
    });
    expect(response.status).toBe(200);
    expect(bodies[0]).toContain('rdkstudio.example.test/api/sso/direct/login');
    expect(bodies[0]).toContain('"method":"account"');
    const cookies = response.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('rdk_sso_web_session=v1.a.b.c');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).not.toContain('other=skip-me');
  });

  it('maps wrong credentials to 401 and upstream failures to 502', async () => {
    setTestEnv(configuredEnv());
    const deniedApp = makeApp(async () => studioResponse({ status: 401, body: {} }));
    const deniedBase = await listen(deniedApp);
    const denied = await fetch(`${deniedBase}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'op-1', password: 'wrong' }),
    });
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { message: string }).message).toContain('不正确');

    const downApp = makeApp(async () => studioResponse({ status: 500, body: {} }));
    const downBase = await listen(downApp);
    const unavailable = await fetch(`${downBase}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'op-1', password: 'pw' }),
    });
    expect(unavailable.status).toBe(502);
  });

  it('requires both fields (configured env)', async () => {
    setTestEnv(configuredEnv());
    const app = makeApp(async () => studioResponse({ setCookie: ['rdk_sso_web_session=x'] }));
    const base = await listen(app);
    const missing = await fetch(`${base}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'op-1' }),
    });
    expect(missing.status).toBe(400);
  });

  it('fails closed with 503 when the relay is unconfigured', async () => {
    setTestEnv({ RDK_STUDIO_COOKIE_SECRET: undefined, RDK_SIM2REAL_AUTH_MODE: 'studio-cookie' });
    const app = makeApp(async () => studioResponse({ setCookie: ['rdk_sso_web_session=x'] }));
    const base = await listen(app);
    const unconfigured = await fetch(`${base}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'op-1', password: 'pw' }),
    });
    expect(unconfigured.status).toBe(503);
  });

  it('form flow redirects and the login page renders the error banner', async () => {
    setTestEnv(configuredEnv());
    const app = makeApp(async () => studioResponse({ status: 401, body: {} }), 'form');
    const base = await listen(app);
    const denied = await fetch(`${base}/api/sim2real/auth/studio-direct/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userName: 'op-1', password: 'wrong' }).toString(),
      redirect: 'manual',
    });
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe('/login?error=invalid');

    const page = await fetch(`${base}/login?error=invalid`);
    const html = await page.text();
    expect(html).toContain('账号或密码不正确');
    expect(html).toContain('action="/api/sim2real/auth/studio-direct/login"');
  });
});
