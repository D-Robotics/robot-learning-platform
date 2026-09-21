#!/usr/bin/env node

/**
 * Portable backup/verify/restore tooling for the file-backed Sim2Real store.
 *
 * The service deliberately keeps the ledger and telemetry shards on a
 * single-writer filesystem.  This tool creates an inspectable, checksum
 * verified snapshot without copying the ephemeral writer lease.  By default
 * it refuses to run while a writer is alive; `--allow-live` is an explicit
 * best-effort escape hatch and marks the snapshot accordingly.
 *
 * Commands:
 *   backup  --storage-dir DIR --output SNAPSHOT_DIR [--allow-live]
 *   verify  --snapshot SNAPSHOT_DIR
 *   restore --snapshot SNAPSHOT_DIR --storage-dir DIR --yes [--force]
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_SCHEMA_VERSION = 1;
export const LEDGER_FILE_NAME = 'sim2real.json';
export const TELEMETRY_DIR_NAME = 'telemetry';
export const WRITER_LEASE_FILE_NAME = 'writer-lease.json';
/**
 * The audit stream is intentionally kept outside the JSON ledger so an
 * operator can restore domain metadata without re-introducing an old writer
 * lease.  It is still part of the evidence set and must travel with a
 * snapshot whenever it exists.  `.1` is the bounded segment rotated by
 * `server/sim2real/audit-log.ts`.
 */
export const AUDIT_FILE_NAME = 'audit.ndjson';
export const AUDIT_ROTATED_FILE_NAME = `${AUDIT_FILE_NAME}.1`;
export const AUDIT_ENV_NAME = 'RDK_SIM2REAL_AUDIT_FILE';
// Device registry files are part of the standalone deployment state. Keep
// them in the same checksum manifest as the ledger so a restore does not
// resurrect models/runs while silently dropping board ownership metadata.
const EXTRA_ROOT_FILES = new Set(['devices.json', 'device-connections.json']);
// DSH keeps resumable conversation fragments in this cache directory. It is
// intentionally ephemeral and may contain files with an application-owned
// layout, so the ledger backup must not fail just because the cache exists.
const EPHEMERAL_ROOT_DIRECTORIES = new Set(['dsh-sessions']);
const MANIFEST_FILE_NAME = 'backup-manifest.json';
const DEFAULT_STALE_SECONDS = 300;
const REQUIRED_LEDGER_ARRAYS = [
  'models',
  'runs',
  'deployments',
  'telemetry',
  'projects',
  'datasets',
  // These collections were added after the original MVP ledger. Requiring
  // them here prevents a backup from silently omitting the artifact/evaluation
  // lineage that release gates rely on.
  'artifacts',
  'evaluations',
  'computeResources',
];

const AUDIT_PATH_PATTERN = /^(?:audit\.ndjson(?:\.1)?)$/;
const TELEMETRY_PATH_PATTERN = /^telemetry\/[\w-]{1,128}\.jsonl$/;
const PRIVATE_DIRECTORY_MODE = 0o700;

function fail(message, code = 'STORAGE_BACKUP_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ensureAbsolute(input, label) {
  const raw = String(input ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) fail(`${label} 必须是绝对路径`);
  return path.normalize(raw);
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function resolveAuditFile(storageDir, configured) {
  const explicit = String(configured ?? '').trim();
  const raw = explicit || String(process.env[AUDIT_ENV_NAME] ?? '').trim();
  if (!raw) return path.join(storageDir, AUDIT_FILE_NAME);
  return ensureAbsolute(raw, `${AUDIT_ENV_NAME}/audit-file`);
}

function auditSourceDescriptors(storageDir, configured) {
  const current = resolveAuditFile(storageDir, configured);
  const rotated = `${current}.1`;
  // The audit writer only supports one current segment and one rotated
  // segment. Keep the canonical snapshot names stable even when an operator
  // places the source stream outside the ledger directory.
  return [
    { sourcePath: current, relativePath: AUDIT_FILE_NAME, kind: 'audit' },
    { sourcePath: rotated, relativePath: AUDIT_ROTATED_FILE_NAME, kind: 'audit' },
  ];
}

async function regularFile(file, label) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} 不存在`, 'STORAGE_BACKUP_SOURCE_MISSING');
    throw error;
  }
  if (info.isSymbolicLink()) fail(`${label} 不能是符号链接`, 'STORAGE_BACKUP_SYMLINK');
  if (!info.isFile()) fail(`${label} 不是普通文件`, 'STORAGE_BACKUP_SOURCE_INVALID');
  return info;
}

async function safeDirectory(dir, label, { create = false } = {}) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir).catch((error) => {
    if (error?.code === 'ENOENT') fail(`${label} 不存在`, 'STORAGE_BACKUP_SOURCE_MISSING');
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory())
    fail(`${label} 不是安全目录`, 'STORAGE_BACKUP_SOURCE_INVALID');
  return info;
}

function isTrustedDarwinRootAlias(link, target) {
  // macOS exposes the writable temporary and variable-data trees through
  // /tmp and /var symlinks. They are OS-owned aliases; every other symlink in
  // an audit destination path is rejected so restore cannot be redirected into
  // an operator-controlled tree.
  if (process.platform !== 'darwin') return false;
  const normalized = path.normalize(link);
  return (normalized === '/tmp' || normalized === '/var') && target === `/private${normalized}`;
}

/**
 * Ensure an external audit destination lives below a private, ordinary
 * directory. The restore command replaces a regular file atomically, so a
 * caller-controlled path such as /etc/passwd must fail before the target tree
 * is switched. Missing final directories are created as 0700; broad existing
 * directories and ancestor symlinks fail closed.
 */
async function ensureSecureAuditParent(file, label) {
  const parent = path.dirname(file);
  const root = path.parse(parent).root;
  const components = path.relative(root, parent).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(current);
      if (!isTrustedDarwinRootAlias(current, target))
        fail(`${label} 的目录路径不能包含符号链接`, 'STORAGE_BACKUP_SYMLINK');
      current = target;
      continue;
    }
    if (!info.isDirectory()) fail(`${label} 的父路径不是目录`, 'STORAGE_BACKUP_SOURCE_INVALID');
  }
  const finalInfo = await lstat(current);
  if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory())
    fail(`${label} 的父路径不是安全目录`, 'STORAGE_BACKUP_SOURCE_INVALID');
  if ((finalInfo.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE)
    fail(`${label} 的父目录必须是 0700`, 'STORAGE_BACKUP_AUDIT_PATH_INVALID');
  return current;
}

async function sha256(file) {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function syncFile(file) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir) {
  try {
    const handle = await open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem (notably
    // some macOS volumes). File contents are still synced; atomic rename is
    // the durability boundary used by the service itself.
  }
}

function parseLedger(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${label} 不是合法 JSON`, 'STORAGE_BACKUP_LEDGER_INVALID');
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    fail(`${label} 的 ledger version 不受支持`, 'STORAGE_BACKUP_LEDGER_INVALID');
  }
  for (const key of REQUIRED_LEDGER_ARRAYS) {
    if (!Array.isArray(parsed[key]))
      fail(`${label} 缺少数组字段 ${key}`, 'STORAGE_BACKUP_LEDGER_INVALID');
  }
  return parsed;
}

async function validateTelemetry(file, label) {
  const raw = await readFile(file, 'utf8');
  let rows = 0;
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`${label} 第 ${index + 1} 行不是合法 JSON`, 'STORAGE_BACKUP_TELEMETRY_INVALID');
    }
    if (!isRecord(parsed))
      fail(`${label} 第 ${index + 1} 行不是对象`, 'STORAGE_BACKUP_TELEMETRY_INVALID');
    rows += 1;
  }
  return rows;
}

const AUDIT_OUTCOMES = new Set(['succeeded', 'failed', 'denied']);
const MAX_AUDIT_EVENT_BYTES = 64 * 1024;
const SENSITIVE_AUDIT_KEY = /token|secret|password|cookie|authorization|requestbody/i;

function containsSensitiveAuditKey(value, depth = 0) {
  if (depth > 5 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveAuditKey(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => SENSITIVE_AUDIT_KEY.test(key) || containsSensitiveAuditKey(item, depth + 1),
  );
}

/** Validate the privacy-safe NDJSON shape emitted by audit-log.ts. */
async function validateAudit(file, label) {
  const raw = await readFile(file, 'utf8');
  let rows = 0;
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_EVENT_BYTES) {
      fail(`${label} 第 ${index + 1} 行超过审计事件大小上限`, 'STORAGE_BACKUP_AUDIT_INVALID');
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`${label} 第 ${index + 1} 行不是合法 JSON`, 'STORAGE_BACKUP_AUDIT_INVALID');
    }
    if (!isRecord(parsed)) {
      fail(`${label} 第 ${index + 1} 行不是对象`, 'STORAGE_BACKUP_AUDIT_INVALID');
    }
    for (const key of ['id', 'at', 'action', 'resourceType']) {
      if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
        fail(`${label} 第 ${index + 1} 行缺少 ${key}`, 'STORAGE_BACKUP_AUDIT_INVALID');
      }
    }
    if (
      !Number.isSafeInteger(parsed.status) ||
      parsed.status < 100 ||
      parsed.status > 599 ||
      typeof parsed.outcome !== 'string' ||
      !AUDIT_OUTCOMES.has(parsed.outcome)
    ) {
      fail(`${label} 第 ${index + 1} 行状态字段无效`, 'STORAGE_BACKUP_AUDIT_INVALID');
    }
    // A malformed stream must never turn the backup tool into a credential
    // exfiltration path. The runtime drops these keys before appending; reject
    // them here as a second, independent boundary.
    if (containsSensitiveAuditKey(parsed)) {
      fail(`${label} 第 ${index + 1} 行疑似包含敏感字段`, 'STORAGE_BACKUP_AUDIT_INVALID');
    }
    rows += 1;
  }
  return rows;
}

function validShardName(name) {
  return /^[\w-]{1,128}\.jsonl$/.test(name);
}

/** Return the payload files that are part of a store snapshot. */
export async function inspectStorage(storageDir, options = {}) {
  const root = ensureAbsolute(storageDir, 'storage-dir');
  await safeDirectory(root, 'storage-dir');
  const ledgerPath = path.join(root, LEDGER_FILE_NAME);
  const ledgerInfo = await regularFile(ledgerPath, LEDGER_FILE_NAME);
  if (ledgerInfo.size === 0) fail('sim2real.json 为空', 'STORAGE_BACKUP_LEDGER_INVALID');
  const ledger = parseLedger(await readFile(ledgerPath, 'utf8'), LEDGER_FILE_NAME);
  const files = [{ relativePath: LEDGER_FILE_NAME, absolutePath: ledgerPath, kind: 'ledger' }];
  let telemetryRows = 0;
  let auditRows = 0;
  const auditDescriptors = auditSourceDescriptors(root, options.auditFile);
  const auditRootNames = new Set();
  for (const descriptor of auditDescriptors) {
    if (!pathInside(root, descriptor.sourcePath)) continue;
    // Keep the root allow-list unambiguous. A nested custom audit path could
    // hide unrelated files beside the stream, so use a root file or an
    // explicitly external absolute path.
    if (path.dirname(descriptor.sourcePath) !== root) {
      fail(
        `${AUDIT_ENV_NAME} 必须指向存储目录根部文件，或放在存储目录之外`,
        'STORAGE_BACKUP_AUDIT_PATH_INVALID',
      );
    }
    if (descriptor.sourcePath === ledgerPath) {
      fail('审计文件不能覆盖 sim2real.json', 'STORAGE_BACKUP_AUDIT_PATH_INVALID');
    }
    auditRootNames.add(path.basename(descriptor.sourcePath));
  }
  const telemetryDir = path.join(root, TELEMETRY_DIR_NAME);
  try {
    await safeDirectory(telemetryDir, TELEMETRY_DIR_NAME);
  } catch (error) {
    if (error?.code !== 'STORAGE_BACKUP_SOURCE_MISSING') throw error;
  }
  let telemetryEntries = [];
  try {
    telemetryEntries = await readdir(telemetryDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of telemetryEntries) {
    if (!validShardName(entry.name))
      fail(`telemetry/ 中存在非法分片名 ${entry.name}`, 'STORAGE_BACKUP_SOURCE_INVALID');
    if (entry.isSymbolicLink() || !entry.isFile())
      fail(`telemetry/${entry.name} 不是普通文件`, 'STORAGE_BACKUP_SYMLINK');
    const absolutePath = path.join(telemetryDir, entry.name);
    const info = await regularFile(absolutePath, `telemetry/${entry.name}`);
    telemetryRows += await validateTelemetry(absolutePath, `telemetry/${entry.name}`);
    files.push({
      relativePath: `${TELEMETRY_DIR_NAME}/${entry.name}`,
      absolutePath,
      kind: 'telemetry',
      bytes: info.size,
    });
  }
  for (const name of EXTRA_ROOT_FILES) {
    const absolutePath = path.join(root, name);
    let info;
    try {
      info = await regularFile(absolutePath, name);
    } catch (error) {
      if (error?.code === 'STORAGE_BACKUP_SOURCE_MISSING') continue;
      throw error;
    }
    files.push({ relativePath: name, absolutePath, kind: 'state', bytes: info.size });
  }
  for (const descriptor of auditDescriptors) {
    let info;
    try {
      info = await lstat(descriptor.sourcePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      fail(`${descriptor.sourcePath} 不是普通审计文件`, 'STORAGE_BACKUP_SYMLINK');
    }
    auditRows += await validateAudit(descriptor.sourcePath, descriptor.relativePath);
    files.push({
      relativePath: descriptor.relativePath,
      absolutePath: descriptor.sourcePath,
      kind: descriptor.kind,
      bytes: info.size,
    });
  }
  // Fail on unexpected root entries instead of silently leaving application
  // state out of a backup. The writer lease and atomic temporary files are
  // ephemeral by design and are intentionally excluded.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.name === LEDGER_FILE_NAME ||
      entry.name === TELEMETRY_DIR_NAME ||
      entry.name === WRITER_LEASE_FILE_NAME ||
      auditRootNames.has(entry.name) ||
      EXTRA_ROOT_FILES.has(entry.name) ||
      EPHEMERAL_ROOT_DIRECTORIES.has(entry.name)
    )
      continue;
    // Operator-created ledger snapshots are immutable historical inputs, not
    // live state. Keep them out of the active manifest while allowing the
    // backup job to run against a directory that contains one.
    if (/\.tmp$/.test(entry.name) || /^sim2real\.json\./.test(entry.name)) continue;
    fail(`storage-dir 中存在未纳入备份的条目 ${entry.name}`, 'STORAGE_BACKUP_SOURCE_INVALID');
  }
  return {
    root,
    ledger,
    files,
    telemetryRows,
    auditRows,
    auditFiles: files.filter((item) => item.kind === 'audit').length,
    ledgerBytes: ledgerInfo.size,
  };
}

async function readLease(storageDir) {
  const file = path.join(storageDir, WRITER_LEASE_FILE_NAME);
  let leaseInfo;
  try {
    leaseInfo = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`无法读取 writer-lease.json：${error.message}`, 'STORAGE_BACKUP_LEASE_UNKNOWN');
  }
  if (leaseInfo.isSymbolicLink() || !leaseInfo.isFile())
    fail('writer-lease.json 不是普通文件，无法确认写入者状态', 'STORAGE_BACKUP_LEASE_UNKNOWN');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`无法读取 writer-lease.json：${error.message}`, 'STORAGE_BACKUP_LEASE_UNKNOWN');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('writer-lease.json 已损坏，无法确认写入者状态', 'STORAGE_BACKUP_LEASE_UNKNOWN');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.host !== 'string' ||
    !parsed.host.trim() ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.heartbeatAt !== 'string' ||
    !parsed.heartbeatAt.trim()
  ) {
    fail('writer-lease.json 格式不受支持，无法确认写入者状态', 'STORAGE_BACKUP_LEASE_UNKNOWN');
  }
  return parsed;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export async function assessWriter(storageDir, staleSeconds = DEFAULT_STALE_SECONDS) {
  const lease = await readLease(storageDir);
  if (!lease) return { state: 'quiescent', lease: null, reason: '没有 writer lease' };
  const selfHost = os.hostname();
  if (lease.host === selfHost && processAlive(lease.pid)) {
    return { state: 'active', lease, reason: `本机 pid ${lease.pid} 仍存活` };
  }
  const heartbeat = Date.parse(lease.heartbeatAt);
  const ageMs = Number.isFinite(heartbeat) ? Date.now() - heartbeat : Number.POSITIVE_INFINITY;
  if (ageMs <= staleSeconds * 1000) {
    return { state: 'active', lease, reason: `writer heartbeat 在 ${staleSeconds} 秒阈值内` };
  }
  return { state: 'stale', lease, reason: 'writer lease 已过期，可在维护窗口内备份/恢复' };
}

async function copyPayload(destination, files) {
  const copied = [];
  let changedDuringCopy = false;
  for (const file of files) {
    const before = await stat(file.absolutePath);
    const digest = await sha256(file.absolutePath);
    const target = path.join(destination, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.absolutePath, target);
    await chmod(target, 0o600);
    await syncFile(target);
    const after = await stat(file.absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) changedDuringCopy = true;
    const targetInfo = await stat(target);
    copied.push({
      path: file.relativePath,
      bytes: targetInfo.size,
      sha256: digest,
      kind: file.kind,
    });
  }
  await syncDirectory(destination);
  return { copied, changedDuringCopy };
}

export async function verifySnapshot(snapshotDir) {
  const root = ensureAbsolute(snapshotDir, 'snapshot');
  await safeDirectory(root, 'snapshot');
  const manifestPath = path.join(root, MANIFEST_FILE_NAME);
  await regularFile(manifestPath, MANIFEST_FILE_NAME);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail('backup-manifest.json 不是合法 JSON', 'STORAGE_BACKUP_MANIFEST_INVALID');
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !Array.isArray(manifest.files)
  ) {
    fail('backup-manifest.json 版本或 files 字段无效', 'STORAGE_BACKUP_MANIFEST_INVALID');
  }
  const expected = new Map();
  for (const item of manifest.files) {
    const validPath =
      isRecord(item) &&
      typeof item.path === 'string' &&
      (item.path === LEDGER_FILE_NAME ||
        EXTRA_ROOT_FILES.has(item.path) ||
        TELEMETRY_PATH_PATTERN.test(item.path) ||
        AUDIT_PATH_PATTERN.test(item.path));
    if (
      !validPath ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0
    ) {
      fail('backup-manifest.json 包含非法文件项', 'STORAGE_BACKUP_MANIFEST_INVALID');
    }
    const expectedKind =
      item.path === LEDGER_FILE_NAME
        ? 'ledger'
        : EXTRA_ROOT_FILES.has(item.path)
          ? 'state'
          : TELEMETRY_PATH_PATTERN.test(item.path)
            ? 'telemetry'
            : 'audit';
    if (item.kind !== undefined && item.kind !== expectedKind) {
      fail(
        `backup-manifest.json 文件类型与路径不一致：${item.path}`,
        'STORAGE_BACKUP_MANIFEST_INVALID',
      );
    }
    if (expected.has(item.path))
      fail(`backup-manifest.json 重复文件 ${item.path}`, 'STORAGE_BACKUP_MANIFEST_INVALID');
    expected.set(item.path, item);
  }
  if (!expected.has(LEDGER_FILE_NAME))
    fail('备份缺少 sim2real.json', 'STORAGE_BACKUP_MANIFEST_INVALID');
  const actual = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE_NAME) continue;
    if (entry.isSymbolicLink()) fail(`备份包含符号链接 ${entry.name}`, 'STORAGE_BACKUP_SYMLINK');
    if (entry.name === TELEMETRY_DIR_NAME) {
      if (!entry.isDirectory()) fail('备份 telemetry 不是目录', 'STORAGE_BACKUP_SOURCE_INVALID');
      for (const shard of await readdir(path.join(root, TELEMETRY_DIR_NAME), {
        withFileTypes: true,
      })) {
        if (shard.isSymbolicLink() || !shard.isFile() || !validShardName(shard.name))
          fail(`备份 telemetry/${shard.name} 非法`, 'STORAGE_BACKUP_SOURCE_INVALID');
        actual.push(`${TELEMETRY_DIR_NAME}/${shard.name}`);
      }
      continue;
    }
    if (!entry.isFile()) fail(`备份包含未声明条目 ${entry.name}`, 'STORAGE_BACKUP_SOURCE_INVALID');
    actual.push(entry.name);
  }
  if (actual.length !== expected.size || actual.some((item) => !expected.has(item)))
    fail('备份文件清单与 manifest 不一致', 'STORAGE_BACKUP_MANIFEST_INVALID');
  let telemetryRows = 0;
  let auditRows = 0;
  for (const item of expected.values()) {
    const file = path.join(root, item.path);
    const info = await regularFile(file, item.path);
    if (info.size !== item.bytes || (await sha256(file)) !== item.sha256)
      fail(`${item.path} SHA-256 或大小不匹配`, 'STORAGE_BACKUP_DIGEST_MISMATCH');
    if (TELEMETRY_PATH_PATTERN.test(item.path))
      telemetryRows += await validateTelemetry(file, item.path);
    if (AUDIT_PATH_PATTERN.test(item.path)) auditRows += await validateAudit(file, item.path);
  }
  // Verify every digest before interpreting the payload. This makes a
  // tampered ledger fail with the actionable checksum error rather than a
  // misleading schema error (and avoids parsing untrusted bytes first).
  const ledgerPath = path.join(root, LEDGER_FILE_NAME);
  const ledger = parseLedger(await readFile(ledgerPath, 'utf8'), LEDGER_FILE_NAME);
  return { root, manifest, ledger, files: expected.size, telemetryRows, auditRows };
}

export async function createBackup({
  storageDir,
  output,
  allowLive = false,
  staleSeconds = DEFAULT_STALE_SECONDS,
  auditFile,
} = {}) {
  const source = await inspectStorage(storageDir, { auditFile });
  const writer = await assessWriter(source.root, staleSeconds);
  if (writer.state === 'active' && !allowLive)
    fail(
      `检测到活跃写入者：${writer.reason}。请先停止服务，或明确使用 --allow-live`,
      'STORAGE_BACKUP_WRITER_ACTIVE',
    );
  const destination = ensureAbsolute(output, 'output');
  await access(destination)
    .then(() => fail(`输出目录已存在：${destination}`))
    .catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  // Create only the parent. The destination itself must stay absent until the
  // fully synced staging directory is atomically renamed into place.
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    const copied = await copyPayload(temp, source.files);
    if (copied.changedDuringCopy && !allowLive)
      fail('源存储在复制期间发生变化；为保证一致性已停止', 'STORAGE_BACKUP_SOURCE_CHANGED');
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      tool: 'rdk-sim2real-storage-backup',
      createdAt: new Date().toISOString(),
      consistency: copied.changedDuringCopy || allowLive ? 'best-effort' : 'quiesced',
      source: {
        ledgerVersion: source.ledger.version,
        telemetryRows: source.telemetryRows,
        auditRows: source.auditRows,
        auditFiles: source.auditFiles,
      },
      files: copied.copied,
    };
    const manifestPath = path.join(temp, MANIFEST_FILE_NAME);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await syncFile(manifestPath);
    await syncDirectory(temp);
    await rename(temp, destination);
    await syncDirectory(path.dirname(destination));
    return { snapshot: destination, manifest };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function auditRestoreDescriptors(target, auditFile) {
  const current = resolveAuditFile(target, auditFile);
  const descriptors = new Map([
    [AUDIT_FILE_NAME, { destination: current, kind: 'audit' }],
    [AUDIT_ROTATED_FILE_NAME, { destination: `${current}.1`, kind: 'audit' }],
  ]);
  for (const descriptor of descriptors.values()) {
    const base = path.basename(descriptor.destination);
    if (
      !base ||
      base === LEDGER_FILE_NAME ||
      base === WRITER_LEASE_FILE_NAME ||
      base === TELEMETRY_DIR_NAME
    ) {
      fail(
        '审计恢复目标不能覆盖 ledger、writer lease 或 telemetry',
        'STORAGE_BACKUP_AUDIT_PATH_INVALID',
      );
    }
  }
  return descriptors;
}

async function ensureAtomicAuditReplacement(source, destination, label) {
  await ensureSecureAuditParent(destination, label);
  let temporary = null;
  try {
    const targetInfo = await lstat(destination).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (targetInfo?.isSymbolicLink()) fail(`${label} 不能是符号链接`, 'STORAGE_BACKUP_SYMLINK');
    if (targetInfo && !targetInfo.isFile())
      fail(`${label} 不是普通文件`, 'STORAGE_BACKUP_SOURCE_INVALID');
    temporary = `${destination}.restore-${process.pid}-${randomUUID()}`;
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await syncFile(temporary);
    return { temporary, existed: Boolean(targetInfo) };
  } catch (error) {
    // A failed preparation must not leave an untracked temporary audit file
    // beside the live stream. The caller handles the target-tree transaction.
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function inspectAuditDestination(destination, label) {
  const info = await lstat(destination).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isSymbolicLink()) fail(`${label} 不能是符号链接`, 'STORAGE_BACKUP_SYMLINK');
  if (info && !info.isFile()) fail(`${label} 不是普通文件`, 'STORAGE_BACKUP_SOURCE_INVALID');
  return Boolean(info);
}

async function rollbackAuditReplacements(replacements) {
  let firstError = null;
  for (const replacement of [...replacements].reverse()) {
    if (replacement.temporary) {
      try {
        await rm(replacement.temporary, { force: true });
      } catch (error) {
        firstError ||= error;
      }
    }
    if (replacement.installed) {
      try {
        await rm(replacement.destination, { force: true });
      } catch (error) {
        firstError ||= error;
      }
    }
    if (replacement.movedOriginal && replacement.backup) {
      try {
        await rename(replacement.backup, replacement.destination);
      } catch (error) {
        firstError ||= error;
      }
    }
  }
  if (firstError) throw firstError;
}

export async function restoreBackup({
  snapshotDir,
  storageDir,
  auditFile,
  yes = false,
  force = false,
  staleSeconds = DEFAULT_STALE_SECONDS,
  // Kept as an internal seam so the verification rehearsal can deterministically
  // exercise the post-switch rollback path without relying on filesystem races.
  auditReplacer = ensureAtomicAuditReplacement,
} = {}) {
  if (!yes) fail('恢复会替换目标目录；请显式传入 --yes', 'STORAGE_BACKUP_CONFIRMATION_REQUIRED');
  if (typeof auditReplacer !== 'function')
    fail('审计替换器无效', 'STORAGE_BACKUP_AUDIT_PATH_INVALID');
  const snapshot = await verifySnapshot(snapshotDir);
  const target = ensureAbsolute(storageDir, 'storage-dir');
  if (target === snapshot.root || target.startsWith(`${snapshot.root}${path.sep}`))
    fail('目标存储目录不能位于备份目录内', 'STORAGE_BACKUP_PATH_INVALID');
  let targetExists = true;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail('目标存储目录不能是符号链接', 'STORAGE_BACKUP_SYMLINK');
    if (!info.isDirectory()) fail('目标存储路径不是目录', 'STORAGE_BACKUP_SOURCE_INVALID');
  } catch (error) {
    if (error?.code === 'ENOENT') targetExists = false;
    else throw error;
  }
  if (targetExists) {
    const writer = await assessWriter(target, staleSeconds).catch((error) => {
      if (error?.code === 'STORAGE_BACKUP_SOURCE_MISSING') return { state: 'quiescent' };
      throw error;
    });
    if (writer.state === 'active' && !force)
      fail(
        `目标目录仍有活跃写入者：${writer.reason}；请停服务或使用 --force`,
        'STORAGE_BACKUP_WRITER_ACTIVE',
      );
  }
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = `${target}.restore-${process.pid}-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  let previous = null;
  let targetSwitched = false;
  const auditItems = snapshot.manifest.files.filter((item) => AUDIT_PATH_PATTERN.test(item.path));
  const auditItemsByPath = new Map(auditItems.map((item) => [item.path, item]));
  const auditTargets = auditRestoreDescriptors(target, auditFile);
  const directAudit = [];
  const externalAudit = [];
  const externalAuditCoverage = [];
  for (const [relativePath, descriptor] of auditTargets) {
    const item = auditItemsByPath.get(relativePath);
    const destination = descriptor.destination;
    if (!destination)
      fail(`备份中的审计文件无法映射：${relativePath}`, 'STORAGE_BACKUP_AUDIT_PATH_INVALID');
    if (pathInside(snapshot.root, destination)) {
      fail('审计恢复目标不能位于备份目录内', 'STORAGE_BACKUP_AUDIT_PATH_INVALID');
    }
    const direct = pathInside(target, destination) && path.dirname(destination) === target;
    if (item && direct) {
      const relativePath = path.basename(destination);
      directAudit.push({
        relativePath,
        absolutePath: path.join(snapshot.root, item.path),
        kind: 'audit',
      });
    } else if (!direct) {
      // Keep descriptors for absent snapshot segments as well. Otherwise a
      // stale external `.1` segment would survive a restore silently.
      externalAuditCoverage.push({ item, destination, relativePath });
      if (item) {
        externalAudit.push({
          item,
          destination,
          source: path.join(snapshot.root, item.path),
        });
      }
    }
  }
  const manifestPayload = snapshot.manifest.files
    .filter((item) => !AUDIT_PATH_PATTERN.test(item.path))
    .map((item) => ({
      relativePath: item.path,
      absolutePath: path.join(snapshot.root, item.path),
      kind: item.kind || 'payload',
    }));
  try {
    // Audit files whose configured destination is the storage root can be
    // switched atomically with the ledger and telemetry. Custom or external
    // audit paths are replaced in a second, individually atomic step below.
    await copyPayload(staging, [...manifestPayload, ...directAudit]);
    // Validate external destinations before moving the target. A snapshot that
    // omits a segment must never leave an older external segment in place.
    // Existing destinations are also checked for symlinks/non-files before the
    // transaction crosses its target-tree rename boundary.
    for (const descriptor of externalAuditCoverage) {
      await ensureSecureAuditParent(descriptor.destination, descriptor.relativePath);
      const exists = await inspectAuditDestination(descriptor.destination, descriptor.relativePath);
      if (!descriptor.item && exists) {
        fail(
          `快照缺少外置审计段 ${descriptor.relativePath}，拒绝保留目标中的旧文件`,
          'STORAGE_BACKUP_AUDIT_INCOMPLETE',
        );
      }
    }
    if (targetExists) {
      const previousPath = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
      await rename(target, previousPath);
      previous = previousPath;
    }
    await rename(staging, target);
    targetSwitched = true;
    const replacedAudits = [];
    let currentReplacement = null;
    try {
      for (const replacement of externalAudit) {
        currentReplacement = {
          destination: replacement.destination,
          backup: null,
          temporary: null,
          movedOriginal: false,
          installed: false,
        };
        const prepared = await auditReplacer(
          replacement.source,
          replacement.destination,
          replacement.item.path,
        );
        const backup = prepared.existed
          ? `${replacement.destination}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
          : null;
        currentReplacement.backup = backup;
        currentReplacement.temporary = prepared.temporary;
        if (backup) {
          await rename(replacement.destination, backup);
          currentReplacement.movedOriginal = true;
        }
        await rename(prepared.temporary, replacement.destination);
        currentReplacement.temporary = null;
        currentReplacement.installed = true;
        replacedAudits.push(currentReplacement);
        currentReplacement = null;
      }
    } catch (error) {
      const pending = currentReplacement ? [...replacedAudits, currentReplacement] : replacedAudits;
      try {
        await rollbackAuditReplacements(pending);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
    await syncDirectory(parent);
    return {
      restoredTo: target,
      previous,
      sourceCreatedAt: snapshot.manifest.createdAt,
      consistency: snapshot.manifest.consistency,
      auditFiles: auditItems.length,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    let rollbackError = null;
    if (targetSwitched) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (targetError) {
        rollbackError = targetError;
      }
    }
    if (previous) {
      try {
        await rename(previous, target);
      } catch (targetError) {
        rollbackError ||= targetError;
      }
    }
    if (rollbackError) error.rollbackError = rollbackError;
    await syncDirectory(parent);
    throw error;
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(
      '用法: sim2real-storage-backup.mjs backup --storage-dir DIR --output SNAPSHOT_DIR [--audit-file FILE] [--allow-live] [--stale-seconds N]',
    );
    console.log('      sim2real-storage-backup.mjs verify --snapshot SNAPSHOT_DIR');
    console.log(
      '      sim2real-storage-backup.mjs restore --snapshot SNAPSHOT_DIR --storage-dir DIR [--audit-file FILE] --yes [--force]',
    );
    process.exit(0);
  }
  const [command, ...rest] = argv;
  if (!['backup', 'verify', 'restore'].includes(command))
    throw new Error('命令必须是 backup、verify 或 restore');
  const options = {
    command,
    storageDir: process.env.RDK_SIM2REAL_STORAGE_DIR || '',
    output: '',
    snapshot: '',
    auditFile: process.env[AUDIT_ENV_NAME] || '',
    allowLive: false,
    force: false,
    yes: false,
    json: false,
    staleSeconds: DEFAULT_STALE_SECONDS,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (
      arg === '--storage-dir' ||
      arg === '--output' ||
      arg === '--snapshot' ||
      arg === '--audit-file'
    ) {
      const next = rest[++index];
      if (!next) throw new Error(`${arg} 需要路径`);
      const key =
        arg === '--storage-dir'
          ? 'storageDir'
          : arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = next;
    } else if (arg === '--allow-live') options.allowLive = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--stale-seconds') {
      const parsed = Number(rest[++index]);
      if (!Number.isSafeInteger(parsed) || parsed < 10 || parsed > 86_400)
        throw new Error('--stale-seconds 必须在 10..86400');
      options.staleSeconds = parsed;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: sim2real-storage-backup.mjs backup --storage-dir DIR --output SNAPSHOT_DIR [--audit-file FILE] [--allow-live] [--stale-seconds N]',
      );
      console.log('      sim2real-storage-backup.mjs verify --snapshot SNAPSHOT_DIR');
      console.log(
        '      sim2real-storage-backup.mjs restore --snapshot SNAPSHOT_DIR --storage-dir DIR [--audit-file FILE] --yes [--force]',
      );
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;
  if (options.command === 'backup') {
    const output =
      options.output ||
      path.join(
        process.cwd(),
        'backups',
        `sim2real-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      );
    result = await createBackup({
      storageDir: options.storageDir,
      output,
      auditFile: options.auditFile,
      allowLive: options.allowLive,
      staleSeconds: options.staleSeconds,
    });
  } else if (options.command === 'verify') {
    result = await verifySnapshot(options.snapshot);
  } else {
    result = await restoreBackup({
      snapshotDir: options.snapshot,
      storageDir: options.storageDir,
      auditFile: options.auditFile,
      yes: options.yes,
      force: options.force,
      staleSeconds: options.staleSeconds,
    });
  }
  if (options.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  else if (options.command === 'backup')
    console.log(
      `[storage-backup] PASS — snapshot=${result.snapshot} consistency=${result.manifest.consistency} files=${result.manifest.files.length}`,
    );
  else if (options.command === 'verify')
    console.log(
      `[storage-backup] PASS — verified ${result.files} files, telemetry rows=${result.telemetryRows}, audit rows=${result.auditRows}`,
    );
  else
    console.log(
      `[storage-backup] PASS — restored to ${result.restoredTo}${result.previous ? `; previous=${result.previous}` : ''}`,
    );
}

function isDirectInvocation() {
  return (
    process.argv[1] &&
    // Releases are selected through a deployment-owned `current` symlink.
    // Resolve both sides so the CLI still runs when that symlink points at an
    // immutable versioned directory (systemd and the nightly backup use this
    // path for both standalone and Studio-integrated layouts).
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  );
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(
      `[storage-backup] FAIL — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
