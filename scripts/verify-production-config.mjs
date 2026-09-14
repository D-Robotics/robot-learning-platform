#!/usr/bin/env node

/**
 * Validate the configuration that is allowed to start a shared Sim2Real
 * deployment.
 *
 * This is deliberately dependency-free and never prints secret values.  It
 * can validate a dotenv file, a systemd unit's Environment= overrides, or the
 * checked-in production template.  The template mode is useful in CI: it
 * verifies that the example remains safe without pretending that its blank
 * secret placeholders are deployable credentials.
 *
 * Examples:
 *   node scripts/verify-production-config.mjs --template
 *   node scripts/verify-production-config.mjs \
 *     --env-file /etc/rdk-robot-learning-platform-sim2real.env \
 *     --unit-file services/sim2real-web/standalone-sim2real.service --strict
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(
  ROOT,
  'services',
  'sim2real-web',
  'sim2real.production.env.example',
);
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i;
const TELEMETRY_ATTESTATION_SECRET_KEYS = [
  'RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET',
  'RDK_SIM2REAL_TELEMETRY_TOKEN_SECRET',
  'RDK_SIM2REAL_TELEMETRY_HMAC_SECRET',
];
// Reject both the short sentinel words and the longer explanatory values used
// in checked-in templates (for example
// `replace-with-at-least-32-random-bytes`).  A length-only check would treat a
// copied template as a production signing key and let callers mint attested
// telemetry evidence.
const WEAK_SECRET_RE =
  /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ].*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i;
const REPEATED_SECRET_RE = /^(.)\1{31,}$/s;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_AUTH_MODES = new Set(['trusted-proxy', 'studio-cookie']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Parse the small dotenv dialect used by the deployment templates.  We keep
 * this parser intentionally strict: a typo in a secret-bearing EnvironmentFile
 * must stop a release instead of being silently ignored by a permissive parser.
 */
export function parseDotenv(text) {
  const values = {};
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      errors.push(`第 ${lineNumber} 行不是合法 KEY=VALUE`);
      return;
    }
    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(`第 ${lineNumber} 行重复定义 ${key}`);
      return;
    }
    values[key] = unquoteDotenvValue(rawValue, lineNumber, errors);
  });
  return { values, errors };
}

function unquoteDotenvValue(raw, lineNumber, errors) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    const body = value.slice(1, -1);
    if (first === '"') {
      // Only decode the escapes dotenv users reasonably expect here.  In
      // particular, preserve backslashes in Windows paths and opaque tokens.
      return body.replace(/\\([\\"nrt])/g, (_match, escaped) => {
        if (escaped === 'n') return '\n';
        if (escaped === 'r') return '\r';
        if (escaped === 't') return '\t';
        return escaped;
      });
    }
    return body;
  }
  if (first === '"' || first === "'") {
    errors.push(`第 ${lineNumber} 行引号未闭合`);
    return value;
  }
  // Inline comments are not accepted implicitly: URLs and tokens can contain
  // '#', and silently truncating them is a particularly difficult production
  // failure to diagnose.
  return value;
}

/** Parse simple systemd Environment= assignments without invoking a shell. */
export function parseSystemdEnvironment(text) {
  const values = {};
  const errors = [];
  for (const [index, line] of String(text ?? '')
    .split(/\r?\n/)
    .entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Environment=')) continue;
    const body = trimmed.slice('Environment='.length).trim();
    for (const token of splitSystemdWords(body)) {
      const equals = token.indexOf('=');
      if (equals <= 0) {
        errors.push(`systemd 第 ${index + 1} 行 Environment= 缺少 KEY=`);
        continue;
      }
      const key = token.slice(0, equals);
      if (!ENV_KEY_RE.test(key)) {
        errors.push(`systemd 第 ${index + 1} 行包含非法变量名 ${key}`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        errors.push(`systemd 重复定义 ${key}`);
        continue;
      }
      values[key] = token.slice(equals + 1);
    }
  }
  return { values, errors };
}

/** Parse systemd's absolute writable path declarations without invoking a shell. */
export function parseSystemdWritablePaths(text) {
  const paths = [];
  const errors = [];
  for (const [index, line] of String(text ?? '')
    .split(/\r?\n/)
    .entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('ReadWritePaths=')) continue;
    const body = trimmed.slice('ReadWritePaths='.length).trim();
    for (const token of splitSystemdWords(body)) {
      // systemd accepts a leading '-' to make a missing path non-fatal; the
      // security boundary is the same path, so keep only the path component.
      const candidate = token.startsWith('-') ? token.slice(1) : token;
      if (!candidate || !path.isAbsolute(candidate)) {
        errors.push(`systemd 第 ${index + 1} 行 ReadWritePaths 必须是绝对路径`);
        continue;
      }
      paths.push(path.normalize(candidate));
    }
  }
  return { paths, errors };
}

/** Parse EnvironmentFile= references so the validator can mirror systemd's source boundary. */
export function parseSystemdEnvironmentFiles(text) {
  const files = [];
  const errors = [];
  for (const [index, line] of String(text ?? '')
    .split(/\r?\n/)
    .entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('EnvironmentFile=')) continue;
    const body = trimmed.slice('EnvironmentFile='.length).trim();
    for (const token of splitSystemdWords(body)) {
      const optional = token.startsWith('-');
      const candidate = optional ? token.slice(1) : token;
      if (!candidate || !path.isAbsolute(candidate)) {
        errors.push(`systemd 第 ${index + 1} 行 EnvironmentFile 必须是绝对路径`);
        continue;
      }
      files.push({ path: path.normalize(candidate), optional });
    }
  }
  return { files, errors };
}

/** EnvironmentFile= is evaluated after Environment= by systemd; env wins. */
export function mergeSystemdConfiguration(environmentFileValues = {}, unitValues = {}) {
  return { ...unitValues, ...environmentFileValues };
}

function splitSystemdWords(body) {
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(body)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) current = `${current}${quote}`;
  if (current) words.push(current);
  return words;
}

function check(checks, id, severity, ok, detail, hint) {
  checks.push({ id, severity, status: ok ? 'pass' : severity, detail, ...(hint ? { hint } : {}) });
}

function value(values, key) {
  return String(values[key] ?? '').trim();
}

function isTruthy(valueText) {
  return ['1', 'true', 'yes', 'on'].includes(String(valueText).toLowerCase());
}

function numeric(valueText) {
  if (!/^\d+$/.test(valueText)) return null;
  const parsed = Number(valueText);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function usableSecret(valueText) {
  const text = String(valueText ?? '').trim();
  if (!text || WEAK_SECRET_RE.test(text) || REPEATED_SECRET_RE.test(text)) return false;
  return Buffer.byteLength(text, 'utf8') >= 32 && !/[\u0000-\u001f\u007f]/.test(text);
}

function firstUsableSecret(values, keys = TELEMETRY_ATTESTATION_SECRET_KEYS) {
  for (const key of keys) {
    const candidate = String(values[key] ?? '').trim();
    if (usableSecret(candidate)) return { key, value: candidate };
  }
  return null;
}

function safePathForDetail(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '(未设置)';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function pathWithinWritableRoot(candidate, roots) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  });
}

function urlIsAllowed(raw, { allowLoopbackHttp = true } = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  return allowLoopbackHttp && parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

function originsAreHttps(raw) {
  const origins = String(raw ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    origins.length > 0 &&
    origins.every((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.protocol === 'https:' &&
          parsed.pathname === '/' &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash
        );
      } catch {
        return false;
      }
    })
  );
}

/**
 * Validate a merged configuration. `mode=template` deliberately accepts the
 * blank secret in the repository example while still checking all safe
 * defaults and forbidden development values.
 */
export async function validateProductionConfig({
  values = {},
  mode = 'runtime',
  strict = false,
  envFile = null,
  unitFile = null,
  fileMode = null,
  fileModes = [],
  role = 'writer',
  parseErrors = [],
  unitWritablePaths = [],
} = {}) {
  const checks = [];
  for (const error of parseErrors) check(checks, 'syntax', 'fail', false, error);

  const deployment = value(values, 'RDK_SIM2REAL_DEPLOYMENT');
  const nodeEnv = value(values, 'NODE_ENV');
  const authMode = value(values, 'RDK_SIM2REAL_AUTH_MODE').toLowerCase();
  const ssoRequired = value(values, 'RDK_SIM2REAL_SSO_REQUIRED');
  const bindHost = value(values, 'RDK_SIM2REAL_BIND_HOST');
  const storageDir = value(values, 'RDK_SIM2REAL_STORAGE_DIR');
  const publicBase = value(values, 'RDK_SIM2REAL_PUBLIC_BASE_PATH');
  const dshRuntime = isTruthy(value(values, 'RDK_SIM2REAL_DSH_RUNTIME'));
  const dshHome = value(values, 'RDK_SIM2REAL_DSH_HOME');
  const telemetryAttestationSecret = firstUsableSecret(values);
  const productionShared = nodeEnv === 'production' || deployment === 'web-cloud';

  if (mode === 'template') {
    check(
      checks,
      'template-dev-defaults',
      'fail',
      deployment !== 'local' && storageDir !== '.data',
      '生产模板没有启用 local/.data 开发默认值',
      '不要把 .env.example 直接作为 systemd EnvironmentFile',
    );
    check(
      checks,
      'template-secret-placeholders',
      'fail',
      Object.entries(values)
        .filter(([key]) => SECRET_KEY_RE.test(key))
        .every(
          ([, item]) =>
            !String(item).trim() ||
            /^(replace-with-|changeme|example|placeholder)/i.test(String(item).trim()),
        ),
      '模板中的 secret/token 仅允许为空或明显占位符',
      '删除示例凭据，使用部署机上的 root-only EnvironmentFile',
    );
  }

  if (nodeEnv) {
    check(
      checks,
      'node-env',
      'fail',
      nodeEnv === 'production',
      `NODE_ENV=${nodeEnv}`,
      '生产服务必须使用 NODE_ENV=production',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'node-env',
      'fail',
      false,
      'NODE_ENV 未设置',
      '由 systemd 或 EnvironmentFile 显式设置 NODE_ENV=production',
    );
  } else {
    check(checks, 'node-env', 'warn', true, 'NODE_ENV 由 systemd unit 注入');
  }

  if (deployment) {
    check(
      checks,
      'deployment',
      'fail',
      deployment === 'web-cloud',
      `RDK_SIM2REAL_DEPLOYMENT=${deployment}`,
      '共享部署必须使用 web-cloud',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'deployment',
      'fail',
      false,
      'RDK_SIM2REAL_DEPLOYMENT 未设置',
      '设置 RDK_SIM2REAL_DEPLOYMENT=web-cloud',
    );
  } else {
    check(checks, 'deployment', 'warn', true, 'RDK_SIM2REAL_DEPLOYMENT 由 systemd unit 注入');
  }

  if (ssoRequired) {
    check(
      checks,
      'sso-required',
      'fail',
      ssoRequired === '1',
      `RDK_SIM2REAL_SSO_REQUIRED=${ssoRequired}`,
      '共享部署必须开启 SSO',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'sso-required',
      'fail',
      false,
      'RDK_SIM2REAL_SSO_REQUIRED 未设置',
      '设置 RDK_SIM2REAL_SSO_REQUIRED=1',
    );
  } else {
    check(checks, 'sso-required', 'warn', true, 'SSO 开关由 systemd unit 注入');
  }

  if (authMode) {
    check(
      checks,
      'auth-mode',
      'fail',
      SAFE_AUTH_MODES.has(authMode),
      `认证模式 ${authMode}`,
      '使用 trusted-proxy 或 studio-cookie，并接入已验证身份适配器',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'auth-mode',
      'fail',
      false,
      'RDK_SIM2REAL_AUTH_MODE 未设置',
      '设置 trusted-proxy 或 studio-cookie',
    );
  } else {
    check(checks, 'auth-mode', 'warn', true, '认证模式由 systemd unit 注入');
  }

  const secret = value(values, 'RDK_SIM2REAL_TRUSTED_PROXY_SECRET');
  if (authMode === 'trusted-proxy') {
    if (Buffer.byteLength(secret, 'utf8') >= 32) {
      check(checks, 'trusted-proxy-secret', 'fail', true, 'trusted-proxy secret 长度满足要求');
    } else if (mode === 'template' && !secret) {
      check(
        checks,
        'trusted-proxy-secret',
        'warn',
        true,
        'trusted-proxy secret 留作空占位符（部署前必须注入）',
      );
    } else {
      check(
        checks,
        'trusted-proxy-secret',
        'fail',
        false,
        'trusted-proxy secret 少于 32 字节或未设置',
        '使用至少 32 字节随机 secret，并放入 root-only 文件',
      );
    }
  }

  // Signed board telemetry is part of the canary/live release evidence
  // contract. A missing, copied-template, or weak key must block a runtime
  // deployment; otherwise anyone who knows the example value could mint
  // `attested=true` evidence. Historical aliases remain accepted while keys
  // are rotated, but the canonical variable is preferred when both are valid.
  if (mode === 'template') {
    check(
      checks,
      'telemetry-attestation-secret',
      'warn',
      true,
      telemetryAttestationSecret
        ? `遥测 attestation secret 使用 ${telemetryAttestationSecret.key}`
        : '遥测 attestation secret 留作占位符（部署前必须注入）',
      '使用至少 32 字节随机 secret；不要把模板占位符作为运行配置',
    );
  } else {
    check(
      checks,
      'telemetry-attestation-secret',
      'fail',
      Boolean(telemetryAttestationSecret),
      telemetryAttestationSecret
        ? `遥测 attestation secret 使用 ${telemetryAttestationSecret.key}`
        : '遥测 attestation secret 未设置、过短或仍是模板占位符',
      '设置 RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET（至少 32 字节随机值；轮换期间可暂用旧 alias）',
    );
  }

  const origins = value(values, 'RDK_SIM2REAL_ALLOWED_ORIGINS');
  if (origins) {
    check(
      checks,
      'allowed-origins',
      'fail',
      originsAreHttps(origins),
      'Allowed origins 使用 HTTPS 且不含凭据/query',
      '只填写受信 HTTPS Origin，多个值用逗号分隔',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'allowed-origins',
      'fail',
      false,
      'RDK_SIM2REAL_ALLOWED_ORIGINS 未设置',
      '设置 Studio 的 HTTPS Origin',
    );
  } else {
    check(checks, 'allowed-origins', 'warn', true, 'Allowed origins 由部署方填写');
  }

  if (bindHost) {
    check(
      checks,
      'bind-host',
      'fail',
      LOOPBACK_HOSTS.has(bindHost),
      `监听地址 ${bindHost}`,
      '服务只监听回环地址，由 nginx/网关对外提供访问',
    );
  } else if (mode === 'runtime') {
    check(checks, 'bind-host', 'fail', false, 'RDK_SIM2REAL_BIND_HOST 未设置', '设置 127.0.0.1');
  } else {
    check(checks, 'bind-host', 'warn', true, '监听地址由 systemd unit 注入');
  }

  if (storageDir) {
    const absolute = path.isAbsolute(storageDir);
    const development =
      storageDir === '.data' || storageDir.startsWith('./') || storageDir.startsWith('../');
    check(
      checks,
      'storage-dir',
      'fail',
      absolute && !development,
      `台账目录 ${safePathForDetail(storageDir)}`,
      '使用持久卷上的绝对路径，例如 /var/lib/rdk-robot-learning-platform/sim2real',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'storage-dir',
      'fail',
      false,
      'RDK_SIM2REAL_STORAGE_DIR 未设置',
      '设置持久卷上的绝对路径',
    );
  } else {
    check(checks, 'storage-dir', 'warn', true, '台账目录由 systemd unit 注入');
  }

  if (publicBase) {
    check(
      checks,
      'public-base-path',
      'fail',
      /^\/[^\s]*$/.test(publicBase) && publicBase !== '/',
      `子路径 ${publicBase}`,
      '与反向代理前缀保持一致，例如 /sim2real',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'public-base-path',
      'fail',
      false,
      'RDK_SIM2REAL_PUBLIC_BASE_PATH 未设置',
      '设置 /sim2real',
    );
  } else {
    check(checks, 'public-base-path', 'warn', true, '子路径由 systemd unit 注入');
  }

  const trustProxy = value(values, 'EXPRESS_TRUST_PROXY');
  if (!trustProxy && mode === 'template') {
    check(checks, 'trust-proxy', 'warn', true, 'EXPRESS_TRUST_PROXY 由 systemd/网关部署方显式确认');
  } else {
    check(
      checks,
      'trust-proxy',
      'fail',
      trustProxy === '1',
      `EXPRESS_TRUST_PROXY=${trustProxy || '(未设置)'}`,
      '反向代理部署必须信任且只信任一层代理',
    );
  }

  const rateLimit = numeric(value(values, 'RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE'));
  if (rateLimit === null && mode === 'template') {
    check(
      checks,
      'rate-limit',
      'warn',
      true,
      '限流值使用服务默认值；生产 EnvironmentFile 应显式设置',
    );
  } else {
    check(
      checks,
      'rate-limit',
      'fail',
      rateLimit !== null && rateLimit >= 1 && rateLimit <= 100_000,
      rateLimit === null ? '限流值无效' : `每分钟 ${rateLimit} 次`,
      '设置 1..100000；不要在公网关闭限流',
    );
  }

  const logLevel = value(values, 'RDK_SIM2REAL_LOG_LEVEL').toLowerCase();
  if (!logLevel && mode === 'template') {
    check(
      checks,
      'log-level',
      'warn',
      true,
      '日志级别使用服务默认值 info；生产 EnvironmentFile 应显式设置',
    );
  } else {
    check(
      checks,
      'log-level',
      'fail',
      LOG_LEVELS.has(logLevel),
      `日志级别 ${logLevel || '(未设置)'}`,
      '使用 debug/info/warn/error/silent 之一',
    );
  }

  const cspDisabled = value(values, 'RDK_SIM2REAL_CSP_DISABLE');
  const cspValueValid = !cspDisabled || ['0', '1'].includes(cspDisabled);
  check(
    checks,
    'csp-value',
    'fail',
    cspValueValid,
    cspValueValid ? 'CSP 开关值合法' : `CSP 开关值无效：${cspDisabled}`,
    '只允许设置 0 或 1',
  );
  check(
    checks,
    'csp',
    'fail',
    !isTruthy(cspDisabled),
    isTruthy(cspDisabled) ? 'CSP 被关闭' : 'CSP 保持开启（默认）',
    '生产环境不得设置 RDK_SIM2REAL_CSP_DISABLE=1',
  );

  const hsts = value(values, 'RDK_SIM2REAL_ENABLE_HSTS');
  const hstsValueValid = !hsts || ['0', '1'].includes(hsts);
  check(
    checks,
    'hsts-value',
    'fail',
    hstsValueValid,
    hstsValueValid ? 'HSTS 开关值合法' : `HSTS 开关值无效：${hsts}`,
    '只允许设置 0 或 1',
  );
  check(
    checks,
    'hsts',
    'warn',
    isTruthy(hsts),
    isTruthy(hsts) ? 'HSTS 已开启' : 'HSTS 未开启（HTTPS 网关应开启）',
    '确认所有入口均为 HTTPS 后设置 RDK_SIM2REAL_ENABLE_HSTS=1',
  );
  const hstsSubdomains = value(values, 'RDK_SIM2REAL_HSTS_INCLUDE_SUBDOMAINS');
  check(
    checks,
    'hsts-subdomains-value',
    'fail',
    !hstsSubdomains || ['0', '1'].includes(hstsSubdomains),
    hstsSubdomains
      ? `HSTS includeSubDomains=${hstsSubdomains}`
      : 'HSTS includeSubDomains 使用默认关闭',
    '只允许设置 0 或 1',
  );

  const lease = value(values, 'RDK_SIM2REAL_STORAGE_LEASE');
  const leaseValueValid = !lease || ['0', '1'].includes(lease);
  check(
    checks,
    'storage-lease-value',
    'fail',
    leaseValueValid,
    leaseValueValid ? '写者租约开关值合法' : `写者租约开关值无效：${lease}`,
    '只允许设置 0 或 1',
  );
  check(
    checks,
    'storage-lease',
    'fail',
    lease !== '0',
    lease ? '写者租约保持开启' : '写者租约使用默认开启',
    '不要关闭 RDK_SIM2REAL_STORAGE_LEASE',
  );
  const staleSeconds = numeric(value(values, 'RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS'));
  if (staleSeconds === null && mode === 'template') {
    check(checks, 'storage-lease-stale', 'warn', true, '租约过期阈值使用默认值 300 秒');
  } else {
    check(
      checks,
      'storage-lease-stale',
      'fail',
      staleSeconds !== null && staleSeconds >= 10 && staleSeconds <= 86_400,
      staleSeconds === null ? '租约过期阈值无效' : `租约过期阈值 ${staleSeconds} 秒`,
      '设置 10..86400 秒',
    );
  }

  const readOnly = value(values, 'RDK_SIM2REAL_STORAGE_READ_ONLY');
  const readOnlyValueValid = !readOnly || ['0', '1'].includes(readOnly);
  check(
    checks,
    'storage-role-value',
    'fail',
    readOnlyValueValid,
    readOnlyValueValid ? '只读开关值合法' : `只读开关值无效：${readOnly}`,
    '只允许设置 0 或 1',
  );
  const readOnlyValid = role === 'reader' ? readOnly === '1' : readOnly !== '1';
  check(
    checks,
    'storage-role',
    'fail',
    readOnlyValid,
    role === 'reader' ? '只读副本模式' : '写实例模式（默认）',
    role === 'reader' ? '只读副本设置 RDK_SIM2REAL_STORAGE_READ_ONLY=1' : '写实例不得开启只读模式',
  );

  const maxRuns = numeric(value(values, 'RDK_SIM2REAL_MAX_ACTIVE_RUNS'));
  if (maxRuns === null && mode === 'template') {
    check(
      checks,
      'active-run-cap',
      'warn',
      true,
      '并发任务上限使用默认值 4；生产 EnvironmentFile 应显式设置',
    );
  } else {
    check(
      checks,
      'active-run-cap',
      'fail',
      maxRuns !== null && maxRuns >= 1 && maxRuns <= 100,
      maxRuns === null ? '并发任务上限无效' : `并发任务上限 ${maxRuns}`,
      '设置 1..100',
    );
  }

  const activeRunTtl = numeric(value(values, 'RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS'));
  if (activeRunTtl === null && mode === 'template') {
    check(checks, 'active-run-ttl', 'warn', true, '崩溃窗口 TTL 使用默认值 86400 秒');
  } else {
    check(
      checks,
      'active-run-ttl',
      'fail',
      activeRunTtl !== null && activeRunTtl >= 300 && activeRunTtl <= 604_800,
      activeRunTtl === null ? '崩溃窗口 TTL 无效' : `崩溃窗口 TTL ${activeRunTtl} 秒`,
      '设置 300..604800 秒',
    );
  }

  const computeHealthTtl = numeric(value(values, 'RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS'));
  if (computeHealthTtl === null && mode === 'template') {
    check(checks, 'compute-health-ttl', 'warn', true, 'GPU Worker 健康租约 TTL 使用默认值 600 秒');
  } else {
    check(
      checks,
      'compute-health-ttl',
      'fail',
      computeHealthTtl !== null && computeHealthTtl >= 30 && computeHealthTtl <= 86_400,
      computeHealthTtl === null
        ? 'GPU Worker 健康租约 TTL 无效'
        : `GPU Worker 健康租约 TTL ${computeHealthTtl} 秒`,
      '设置 30..86400 秒',
    );
  }

  const retention = numeric(value(values, 'RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS'));
  if (retention === null && mode === 'template') {
    check(checks, 'telemetry-retention', 'warn', true, '遥测保留策略由部署方按容量预算显式设置');
  } else if (retention === 0) {
    check(
      checks,
      'telemetry-retention',
      'warn',
      true,
      '遥测保留策略为无限期（0）',
      '生产环境按容量预算设置 1..3650 天',
    );
  } else {
    check(
      checks,
      'telemetry-retention',
      'fail',
      retention !== null && retention >= 1 && retention <= 3650,
      retention === null ? '遥测保留值无效' : `遥测保留 ${retention} 天`,
      '设置 1..3650，或明确评审无限期保留',
    );
  }

  const auditFile = value(values, 'RDK_SIM2REAL_AUDIT_FILE');
  if (auditFile) {
    const absolute = path.isAbsolute(auditFile);
    const forbidden =
      auditFile === storageDir || auditFile.endsWith(`${path.sep}${'sim2real.json'}`);
    check(
      checks,
      'audit-file',
      'fail',
      absolute && !forbidden,
      `审计文件 ${safePathForDetail(auditFile)}`,
      '使用持久卷上的绝对 .ndjson 路径，不能覆盖台账目录或 sim2real.json',
    );
  } else if (mode === 'runtime') {
    check(
      checks,
      'audit-file',
      'pass',
      true,
      '审计文件使用 storage-dir/audit.ndjson 默认路径',
      '如需独立日志卷，请设置 RDK_SIM2REAL_AUDIT_FILE 并在备份/恢复时传 --audit-file',
    );
  }
  if (unitFile) {
    const effectiveAuditFile =
      auditFile || (storageDir ? path.join(storageDir, 'audit.ndjson') : '');
    check(
      checks,
      'audit-file-unit-writable',
      'fail',
      Boolean(effectiveAuditFile) && pathWithinWritableRoot(effectiveAuditFile, unitWritablePaths),
      effectiveAuditFile
        ? `审计文件位于 systemd 可写路径：${safePathForDetail(effectiveAuditFile)}`
        : '无法确定审计文件路径',
      '让 ReadWritePaths 覆盖审计文件；默认应覆盖 storage-dir，独立审计卷应使用 /var/log/rdk-sim2real',
    );
  }
  if (dshRuntime) {
    check(
      checks,
      'dsh-home-unit-writable',
      'fail',
      Boolean(dshHome) &&
        path.isAbsolute(dshHome) &&
        pathWithinWritableRoot(dshHome, unitWritablePaths),
      dshHome
        ? `DSH 会话目录位于 systemd 可写路径：${safePathForDetail(dshHome)}`
        : 'DSH 会话目录未设置',
      '让 ReadWritePaths 覆盖 RDK_SIM2REAL_DSH_HOME，并为运行账号预创建 0700 目录',
    );
  }
  const auditMaxBytes = numeric(value(values, 'RDK_SIM2REAL_AUDIT_MAX_BYTES'));
  if (auditMaxBytes === null && value(values, 'RDK_SIM2REAL_AUDIT_MAX_BYTES')) {
    check(
      checks,
      'audit-max-bytes',
      'fail',
      false,
      '审计日志轮转上限无效',
      '设置 1048576..536870912 字节',
    );
  } else if (auditMaxBytes !== null) {
    check(
      checks,
      'audit-max-bytes',
      'fail',
      auditMaxBytes >= 1_048_576 && auditMaxBytes <= 536_870_912,
      `审计日志轮转上限 ${auditMaxBytes} 字节`,
      '设置 1048576..536870912 字节',
    );
  }

  for (const key of [
    'RDK_SIM2REAL_MICRODUCK_URL',
    'RDK_SIM2REAL_LOCAL_RUNNER_URL',
    'RDK_SIM2REAL_ROBOGO_RUNNER_URL',
    'RDK_SIM2REAL_ROBOGO_API_URL',
    'RDK_SIM2REAL_BOARD_AGENT_URL',
  ]) {
    const configured = value(values, key);
    if (!configured) continue;
    check(
      checks,
      key,
      'fail',
      urlIsAllowed(configured),
      `${key} URL 格式合法`,
      '使用 HTTPS；仅允许回环地址使用 HTTP',
    );
  }

  // Runner and BoardAgent URLs are server-to-server trust boundaries. A
  // production process must not silently talk to a reachable internal service
  // without a bearer credential. Local development remains compatible with
  // the reference agents, which intentionally permit an empty token on
  // loopback. RoboGo is excluded because shared-mode requests use a
  // request-scoped token from the authenticated identity adapter.
  for (const [urlKey, tokenKey, label] of [
    ['RDK_SIM2REAL_LOCAL_RUNNER_URL', 'RDK_SIM2REAL_LOCAL_RUNNER_TOKEN', 'Local Runner'],
    ['RDK_SIM2REAL_BOARD_AGENT_URL', 'RDK_SIM2REAL_BOARD_AGENT_TOKEN', 'BoardAgent'],
  ]) {
    const endpoint = value(values, urlKey);
    if (!endpoint || !productionShared) continue;
    const token = value(values, tokenKey);
    const configured = usableSecret(token);
    check(
      checks,
      tokenKey.toLowerCase(),
      mode === 'template' && !token ? 'warn' : 'fail',
      mode === 'template' && !token ? true : configured,
      configured
        ? `${label} bearer 已配置`
        : mode === 'template' && !token
          ? `${label} bearer 留作占位符（部署前必须注入）`
          : `${label} bearer 未设置、过短或仍是模板占位符`,
      `设置 ${tokenKey} 为至少 32 字节随机值，并放入 root-only EnvironmentFile`,
    );
  }

  const configuredFileModes = fileModes.length
    ? fileModes
    : fileMode === null
      ? []
      : [{ path: envFile, mode: fileMode }];
  if (configuredFileModes.length && mode === 'runtime') {
    for (const item of configuredFileModes) {
      const permissive = (item.mode & 0o077) !== 0;
      check(
        checks,
        'env-file-permissions',
        'fail',
        !permissive,
        `${item.path ? `${safePathForDetail(item.path)} ` : ''}EnvironmentFile 权限 ${`000${(item.mode & 0o777).toString(8)}`.slice(-3)}`,
        '将 secret-bearing EnvironmentFile chmod 600（systemd 可在切换 User 前读取）',
      );
    }
  }

  // Strict turns advisory operational debt into a release blocker. The
  // template still remains usable in CI because its placeholder warnings are
  // represented as a successful check with warning severity.
  const failures = checks.filter((item) => item.status === 'fail');
  const warnings = checks.filter((item) => item.status === 'warn');
  const blocking = strict
    ? [
        ...failures,
        ...warnings.filter(
          (item) =>
            item.severity === 'warn' && item.status === 'warn' && !item.detail.includes('占位符'),
        ),
      ]
    : failures;
  return {
    ok: blocking.length === 0,
    mode,
    strict,
    source: {
      envFile,
      envFiles: configuredFileModes.map((item) => item.path).filter(Boolean),
      unitFile,
    },
    summary: {
      passed: checks.filter((item) => item.status === 'pass').length,
      warnings: warnings.length,
      failures: failures.length,
      blocking: blocking.length,
    },
    checks,
  };
}

function parseArgs(argv) {
  const options = {
    template: false,
    strict: false,
    json: false,
    role: 'writer',
    envFile: null,
    envFiles: [],
    unitFile: null,
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--template') options.template = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--reader') options.role = 'reader';
    else if (arg === '--env-file' || arg === '--unit-file') {
      const next = args.shift();
      if (!next) throw new Error(`${arg} 需要路径`);
      if (arg === '--env-file') {
        options.envFiles.push(path.resolve(next));
        options.envFile ||= path.resolve(next);
      } else {
        options.unitFile = path.resolve(next);
      }
    } else if (arg === '--role') {
      const next = args.shift();
      if (!['reader', 'writer'].includes(next)) throw new Error('--role 只能是 reader 或 writer');
      options.role = next;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: verify-production-config.mjs [--template | --env-file FILE ...] [--unit-file FILE] [--strict] [--json] [--role writer|reader]',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return options;
}

async function loadInput(options) {
  const envFiles = options.envFiles?.length
    ? [...options.envFiles]
    : options.envFile
      ? [options.envFile]
      : [];
  const template = options.template || envFiles.length === 0;
  const selected = envFiles[0] || TEMPLATE_PATH;
  let parseErrors = [];
  let values = {};
  for (const file of envFiles.length ? envFiles : [TEMPLATE_PATH]) {
    const parsed = parseDotenv(await readFile(file, 'utf8'));
    parseErrors = [...parseErrors, ...parsed.errors.map((error) => `${file}: ${error}`)];
    values = { ...values, ...parsed.values };
  }
  let unitWritablePaths = [];
  let unitEnvironmentFiles = [];
  const unitFile = options.unitFile;
  if (unitFile) {
    const unitRaw = await readFile(unitFile, 'utf8');
    const unit = parseSystemdEnvironment(unitRaw);
    const writable = parseSystemdWritablePaths(unitRaw);
    const environmentFiles = parseSystemdEnvironmentFiles(unitRaw);
    parseErrors = [...parseErrors, ...unit.errors];
    parseErrors = [...parseErrors, ...writable.errors];
    parseErrors = [...parseErrors, ...environmentFiles.errors];
    unitWritablePaths = writable.paths;
    unitEnvironmentFiles = environmentFiles.files;
    // systemd reads EnvironmentFile= after Environment=, so an env-file value
    // wins even when the Environment= line appears later in the unit. Mirror
    // that precedence instead of validating a configuration the process will
    // never actually receive.
    values = mergeSystemdConfiguration(values, unit.values);
    if (envFiles.length && unitEnvironmentFiles.length > 0) {
      const supplied = new Set(envFiles.map((file) => path.resolve(file)));
      const referenced = new Set(unitEnvironmentFiles.map((item) => path.resolve(item.path)));
      const unexpected = [...supplied].filter((file) => !referenced.has(file));
      const missing = unitEnvironmentFiles
        .filter((item) => !item.optional && !supplied.has(path.resolve(item.path)))
        .map((item) => item.path);
      if (unexpected.length || missing.length) {
        parseErrors.push(
          `EnvironmentFile 与 --env-file 不一致：未引用 ${unexpected.join(', ') || '无'}；缺少 ${missing.join(', ') || '无'}`,
        );
      }
    }
  }
  let fileMode = null;
  const fileModes = [];
  for (const file of envFiles) {
    const mode = (await stat(file)).mode;
    fileModes.push({ path: file, mode });
    if (fileMode === null) fileMode = mode;
  }
  return {
    values,
    mode: template ? 'template' : 'runtime',
    envFile: envFiles.length ? selected : null,
    envFiles,
    unitFile: unitFile || null,
    fileMode,
    fileModes,
    parseErrors,
    unitWritablePaths,
    unitEnvironmentFiles,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = await loadInput(options);
  const report = await validateProductionConfig({
    ...input,
    strict: options.strict,
    role: options.role,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nRDK Sim2Real 生产配置检查 (${report.mode}${report.strict ? ', strict' : ''})`);
    for (const item of report.checks) {
      const icon = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗';
      console.log(`  ${icon} ${item.id} — ${item.detail}`);
      if (item.hint && item.status !== 'pass') console.log(`      ↳ ${item.hint}`);
    }
    console.log(
      `\n结论: ${report.ok ? '通过' : '阻断'} · ${report.summary.failures} 个失败 / ${report.summary.warnings} 个提醒${report.strict ? ` / ${report.summary.blocking} 个阻断` : ''}\n`,
    );
  }
  process.exitCode = report.ok ? 0 : 1;
}

function isDirectInvocation() {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invoked === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[production-config] FAIL — ${message}`);
    process.exitCode = 1;
  });
}
