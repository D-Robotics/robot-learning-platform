import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_SIM2REAL_WEB_BIND_HOST,
  DEFAULT_SIM2REAL_WEB_PORT,
  isProductionEnv,
  normalizeMicroduckRedirect,
  normalizePublicBasePath,
  parseBooleanFlag,
  parseDirectBoardAgentUrl,
  parsePortValue,
  parseTrustProxyFlag,
  resolveMicroduckStaticRoot,
  resolveSim2RealWebEnv,
} from './runtime-config.js';

const tempRoots: string[] = [];

function tempMicroduckRelease(withEntry: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sim2real-web-runtime-config-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'current'), { recursive: true });
  if (withEntry) writeFileSync(path.join(root, 'current', 'index.html'), '<html></html>');
  return path.join(root, 'current');
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('parsePortValue', () => {
  it('accepts integers in the unprivileged range', () => {
    expect(parsePortValue('18999')).toEqual({ port: 18_999 });
    expect(parsePortValue(1_810_2)).toEqual({ port: 18_102 });
  });

  it('falls back to the default without noise when unset', () => {
    expect(parsePortValue(undefined)).toEqual({ port: DEFAULT_SIM2REAL_WEB_PORT });
    expect(parsePortValue(null)).toEqual({ port: DEFAULT_SIM2REAL_WEB_PORT });
  });

  it('warns instead of silently defaulting on garbage', () => {
    const garbage = parsePortValue('808o');
    expect(garbage.port).toBe(DEFAULT_SIM2REAL_WEB_PORT);
    expect(garbage.warning).toContain('RDK_SIM2REAL_PORT');
    expect(parsePortValue('80').warning).toBeDefined();
    expect(parsePortValue('65536').warning).toBeDefined();
    expect(parsePortValue('').warning).toBeDefined();
  });
});

describe('parseBooleanFlag', () => {
  it('accepts the documented truthy spellings', () => {
    for (const raw of ['1', 'true', 'YES', 'on', ' true ']) {
      expect(parseBooleanFlag(raw)).toBe(true);
    }
  });

  it('treats everything else as false', () => {
    for (const raw of ['0', 'false', 'enabled', '', undefined, null]) {
      expect(parseBooleanFlag(raw)).toBe(false);
    }
  });
});

describe('isProductionEnv', () => {
  it('matches only the exact production spelling', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'Production ' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });
});

describe('normalizePublicBasePath', () => {
  it('treats empty and root as an unmounted prefix', () => {
    expect(normalizePublicBasePath('')).toBe('');
    expect(normalizePublicBasePath('/')).toBe('');
    expect(normalizePublicBasePath(undefined)).toBe('');
  });

  it('canonicalizes a single-segment and nested prefix', () => {
    expect(normalizePublicBasePath('sim2real')).toBe('/sim2real');
    expect(normalizePublicBasePath('/sim2real/')).toBe('/sim2real');
    expect(normalizePublicBasePath('a/b')).toBe('/a/b');
  });

  it('fails closed on characters a mount prefix should not carry', () => {
    expect(normalizePublicBasePath('foo bar')).toBe('');
    expect(normalizePublicBasePath('../etc')).toBe('');
    expect(normalizePublicBasePath('sim2real?x')).toBe('');
  });
});

describe('normalizeMicroduckRedirect', () => {
  it('accepts https and loopback http targets', () => {
    expect(normalizeMicroduckRedirect('https://sim.example.org/app/')).toBe(
      'https://sim.example.org/app/',
    );
    expect(normalizeMicroduckRedirect('http://127.0.0.1:7860')).toBe('http://127.0.0.1:7860/');
    expect(normalizeMicroduckRedirect(' http://localhost:7860/ ')).toBe('http://localhost:7860/');
  });

  it('rejects non-loopback plain http and smuggled state', () => {
    expect(normalizeMicroduckRedirect('http://sim.example.org/')).toBeNull();
    expect(normalizeMicroduckRedirect('https://user:pass@sim.example.org/')).toBeNull();
    expect(normalizeMicroduckRedirect('https://sim.example.org/?a=1')).toBeNull();
    expect(normalizeMicroduckRedirect('https://sim.example.org/#frame')).toBeNull();
    expect(normalizeMicroduckRedirect('not a url')).toBeNull();
    expect(normalizeMicroduckRedirect('')).toBeNull();
  });
});

describe('resolveMicroduckStaticRoot', () => {
  it('rejects relative and missing roots', () => {
    expect(resolveMicroduckStaticRoot('public/microduck')).toBeNull();
    expect(resolveMicroduckStaticRoot('/definitely/not/a/release')).toBeNull();
    expect(resolveMicroduckStaticRoot('')).toBeNull();
  });

  it('accepts an existing directory that carries the entry document', () => {
    const withEntry = tempMicroduckRelease(true);
    expect(resolveMicroduckStaticRoot(withEntry)).toBe(withEntry);
    const withoutEntry = tempMicroduckRelease(false);
    expect(resolveMicroduckStaticRoot(withoutEntry)).toBeNull();
  });
});

describe('parseDirectBoardAgentUrl', () => {
  it('trims and never throws', () => {
    expect(parseDirectBoardAgentUrl(' http://127.0.0.1:9001 ')).toBe('http://127.0.0.1:9001');
    expect(parseDirectBoardAgentUrl(undefined)).toBe('');
  });
});

describe('parseTrustProxyFlag', () => {
  it('accepts only the literal 1', () => {
    expect(parseTrustProxyFlag('1')).toBe(true);
    expect(parseTrustProxyFlag(' 1 ')).toBe(true);
    for (const raw of ['true', 'yes', '0', '', undefined]) {
      expect(parseTrustProxyFlag(raw)).toBe(false);
    }
  });
});

describe('resolveSim2RealWebEnv', () => {
  it('returns validated defaults for an empty environment', () => {
    const snapshot = resolveSim2RealWebEnv({});
    expect(snapshot).toEqual({
      port: DEFAULT_SIM2REAL_WEB_PORT,
      host: DEFAULT_SIM2REAL_WEB_BIND_HOST,
      publicBasePath: '',
      microduckRoot: null,
      microduckRedirectUrl: null,
      microduckRequired: false,
      trustProxy: false,
      directBoardAgentUrl: '',
      isProduction: false,
      warnings: [],
    });
  });

  it('collects one warning per rejected value instead of failing the boot', () => {
    const snapshot = resolveSim2RealWebEnv({
      RDK_SIM2REAL_PORT: 'http',
      RDK_SIM2REAL_PUBLIC_BASE_PATH: 'bad path',
      RDK_SIM2REAL_MICRODUCK_URL: 'ftp://sim.example.org/',
    });
    expect(snapshot.warnings).toHaveLength(3);
    expect(snapshot.port).toBe(DEFAULT_SIM2REAL_WEB_PORT);
    expect(snapshot.publicBasePath).toBe('');
    expect(snapshot.microduckRedirectUrl).toBeNull();
  });

  it('keeps a fully valid configuration verbatim', () => {
    const release = tempMicroduckRelease(true);
    const snapshot = resolveSim2RealWebEnv({
      RDK_SIM2REAL_PORT: '28102',
      RDK_SIM2REAL_BIND_HOST: ' 0.0.0.0 ',
      RDK_SIM2REAL_PUBLIC_BASE_PATH: 'lab',
      RDK_SIM2REAL_MICRODUCK_ROOT: release,
      RDK_SIM2REAL_MICRODUCK_URL: 'https://sim.example.org/',
      RDK_SIM2REAL_REQUIRE_MICRODUCK: 'yes',
      EXPRESS_TRUST_PROXY: '1',
      RDK_SIM2REAL_BOARD_AGENT_URL: 'http://127.0.0.1:9001',
      NODE_ENV: 'production',
    });
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.port).toBe(28_102);
    expect(snapshot.host).toBe('0.0.0.0');
    expect(snapshot.publicBasePath).toBe('/lab');
    expect(snapshot.microduckRoot).toBe(release);
    expect(snapshot.microduckRedirectUrl).toBe('https://sim.example.org/');
    expect(snapshot.microduckRequired).toBe(true);
    expect(snapshot.trustProxy).toBe(true);
    expect(snapshot.directBoardAgentUrl).toBe('http://127.0.0.1:9001');
    expect(snapshot.isProduction).toBe(true);
  });
});
