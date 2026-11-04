/** Windows-only DPAPI, CurrentUser scope. No credentials enter process arguments. */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const LIMIT = 65536;
const entropy = Buffer.from('rdk-originman-plugin-binding-v1', 'utf8').toString('base64');

function base64(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200000 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function transform(operation, input, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('Windows DPAPI requires Windows');
  if (!base64(input)) throw new Error('Invalid protected binding payload');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('Invalid Windows system directory');
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = `$ErrorActionPreference='Stop';
try {
 Add-Type -AssemblyName System.Security;
 $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());
 $entropy=[Convert]::FromBase64String('${entropy}');
 $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
 [Console]::Out.Write([Convert]::ToBase64String($result));
} catch { [Console]::Error.Write('Windows DPAPI operation failed'); exit 1 }`;
  const result = run(
    executable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { input, encoding: 'utf8', timeout: 15000, maxBuffer: 262144, windowsHide: true },
  );
  const output = result.stdout?.trim();
  if (result.error || result.status !== 0 || !base64(output))
    throw new Error(
      'Windows DPAPI failed; configure and run under the same Windows user. No unprotected fallback was written.',
    );
  return output;
}

export function validateCredentials(values) {
  const allowed = [
    'RDK_SIM2REAL_MCP_COOKIE',
    'RDK_SIM2REAL_MCP_USERNAME',
    'RDK_SIM2REAL_MCP_PASSWORD',
  ];
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    !Object.keys(values).length ||
    Object.entries(values).some(
      ([key, value]) =>
        !allowed.includes(key) || typeof value !== 'string' || !value || /[\r\n\0]/.test(value),
    ) ||
    Boolean(values.RDK_SIM2REAL_MCP_USERNAME) !== Boolean(values.RDK_SIM2REAL_MCP_PASSWORD)
  )
    throw new Error('Invalid credential fields');
  return values;
}

export function protectWindowsBinding(config, options) {
  const input = Buffer.from(JSON.stringify(config), 'utf8');
  if (input.length > LIMIT) throw new Error('Private binding exceeds 64 KiB');
  return transform('Protect', input.toString('base64'), options);
}

export function unprotectWindowsBinding(ciphertext, expectedRoot, options) {
  const decoded = Buffer.from(transform('Unprotect', ciphertext, options), 'base64');
  if (decoded.length > LIMIT) throw new Error('Private binding exceeds 64 KiB');
  let config;
  try {
    config = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Invalid protected binding');
  }
  if (!config || config.root !== expectedRoot || config.credentialsFile !== undefined)
    throw new Error('Protected binding does not match this plugin installation');
  let url;
  try {
    url = new URL(config.platformUrl);
  } catch {
    throw new Error('Invalid protected platform URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid protected platform URL');
  if (config.credentials !== undefined) validateCredentials(config.credentials);
  return config;
}

export function readWindowsBinding(binding, expectedRoot) {
  if (fs.lstatSync(binding).isSymbolicLink()) throw new Error('Invalid protected binding file');
  const fd = fs.openSync(binding, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 200000) throw new Error('Invalid protected binding file');
    const data = Buffer.alloc(200001);
    let length = 0,
      count;
    while (
      length < data.length &&
      (count = fs.readSync(fd, data, length, data.length - length, null)) > 0
    )
      length += count;
    if (length > 200000) throw new Error('Invalid protected binding file');
    return unprotectWindowsBinding(data.subarray(0, length).toString('utf8').trim(), expectedRoot);
  } finally {
    fs.closeSync(fd);
  }
}

export function windowsBootstrap(root, binding) {
  // The trusted installation path is emitted by its own configurator, not read
  // from an unprotected binding. Ciphertext is not an authentication token.
  return `import path from 'node:path';import{pathToFileURL}from'node:url';
const root=${JSON.stringify(root)};
const{readWindowsBinding}=await import(pathToFileURL(path.join(root,'windows-binding.mjs')).href);
const config=readWindowsBinding(${JSON.stringify(binding)},root);
for(const key of ['RDK_SIM2REAL_MCP_COOKIE','RDK_SIM2REAL_MCP_USERNAME','RDK_SIM2REAL_MCP_PASSWORD','RDK_SIM2REAL_MCP_API_PREFIX'])delete process.env[key];
process.env.RDK_SIM2REAL_MCP_BASE_URL=config.platformUrl;
if(config.credentials)Object.assign(process.env,config.credentials);
const module=await import(pathToFileURL(path.join(root,'scripts/experience-mcp.mjs')).href);module.main();`;
}
