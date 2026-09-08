#!/usr/bin/env node
/**
 * Mock RDK Studio SSO login shell for local end-to-end verification.
 *
 * Emulates the two pieces of the real Studio login chain the Sim2Real relay
 * depends on:
 *   POST /api/sso/direct/login  — validates credentials against a local list
 *                                 and returns the web-cloud session cookie
 *                                 (same AES-256-GCM envelope + secret).
 *   GET  /api/sso/me            — session probe (used by tests only).
 *
 * Only used for `npm run verify` / manual local runs; production relays to the
 * real Studio shell. Credentials are fixed test fixtures, not secrets.
 */
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.MOCK_STUDIO_PORT || 19300);
const SECRET = String(process.env.RDK_STUDIO_COOKIE_SECRET || '').trim();
const COOKIE = 'rdk_sso_web_session';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

const ACCOUNTS = new Map([
  ['demo', { password: 'demo-pass-123', user: { id: 'local-demo-user', name: '本地演示账号', email: 'demo@example.com' } }],
]);

function key(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encodeCookie(user, expiresAt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(SECRET), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ v: 1, user, expiresAt }), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/sso/direct/login') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const method = String(body.method || '');
      if (!['account', 'sms', 'email'].includes(method)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid login method' }));
        return;
      }
      let account = null;
      if (method === 'account') {
        const user = ACCOUNTS.get(String(body.userName || '').trim());
        account = user && String(body.password || '') === user.password ? user : null;
      } else {
        // sms/email: accept any non-empty identifier + code in the mock.
        const identifier = String(body.mobile || body.email || '').trim();
        const code = String(body.code || body.emailcode || '').trim();
        account = identifier && code === '123456'
          ? { user: { id: `local-${method}-${identifier}`, name: identifier, email: method === 'email' ? identifier : '' } }
          : null;
      }
      if (!account) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad_credentials', message: '账号或密码错误（本地模拟）' }));
        return;
      }
      const expiresAt = Date.now() + TTL_MS;
      const cookie = `${COOKIE}=${encodeURIComponent(encodeCookie(account.user, expiresAt))}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.floor(TTL_MS / 1000)}`;
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': cookie,
      });
      res.end(JSON.stringify({ ok: true, user: account.user, sessionId: crypto.randomUUID() }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: true, secretConfigured: SECRET.length >= 32 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  if (SECRET.length < 32) {
    console.error('[mock-studio] RDK_STUDIO_COOKIE_SECRET must be >= 32 chars');
    process.exit(1);
  }
  console.log(`[mock-studio] mock Studio login shell on http://127.0.0.1:${PORT} (account: demo / demo-pass-123, code: 123456)`);
});
