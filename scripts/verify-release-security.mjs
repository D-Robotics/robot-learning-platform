#!/usr/bin/env node

/**
 * Small, dependency-free public-surface scan for CI and release rehearsal.
 *
 * This is intentionally conservative: it blocks high-confidence credential
 * formats and private-key material, while leaving test fixtures and example
 * URLs alone. It complements (and does not replace) an organization-approved
 * secret scanner such as gitleaks before publishing a release.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const HIGH_CONFIDENCE_PATTERNS = [
  { label: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
];

function trackedPublicFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
  });
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relative) => !relative.startsWith('node_modules/'));
}

function isLikelyText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

const findings = [];
for (const relative of trackedPublicFiles()) {
  const absolute = path.join(ROOT, relative);
  let buffer;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
    buffer = fs.readFileSync(absolute);
  } catch {
    continue;
  }
  if (!isLikelyText(buffer)) continue;
  const text = buffer.toString('utf8');
  for (const { label, pattern } of HIGH_CONFIDENCE_PATTERNS) {
    if (pattern.test(text)) findings.push(`${relative}: ${label}`);
  }
  if (/(^|\/)\.env(?:\.[^/]+)?$/.test(relative) && !/(^|\/)\.env\.example$/.test(relative)) {
    findings.push(`${relative}: environment file is part of the public file set`);
  }
}

if (findings.length) {
  console.error('[release-security] BLOCKED — high-confidence public-surface findings:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `[release-security] PASS — scanned ${trackedPublicFiles().length} public source entries; no high-confidence credential material found`,
  );
}
