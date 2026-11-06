import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const mode = process.argv[2];
assert.ok(['installed-node', 'download-node'].includes(mode));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'RDK 公开发行包 '));
const powerShell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(exe,args,options={}) {
  const p=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:210000,...options});
  assert.ifError(p.error);
  assert.equal(p.status,0,p.stdout+p.stderr);
  return p.stdout;
}
function unzip(zip, dest) {
  run(powerShell,['-NoLogo','-NoProfile','-NonInteractive','-Command',
    'Expand-Archive -LiteralPath $env:RDK_TEST_ZIP -DestinationPath $env:RDK_TEST_DEST'],
    {env:{...process.env,RDK_TEST_ZIP:zip,RDK_TEST_DEST:dest}});
}
function verify(root) {
  for (const line of fs.readFileSync(path.join(root,'FILES.sha256'),'utf8').trim().split(/\r?\n/)) {
    const [expected,name]=line.split('  ');
    assert.equal(sha(fs.readFileSync(path.join(root,name))),expected,name);
  }
}
let client;
try {
  const release='https://github.com/D-Robotics/robot-learning-platform/releases/download/plugin-v0.6.8/rdk-robot-learning-platform-0.6.8.zip';
  const res=await fetch(release,{signal:AbortSignal.timeout(30000)});
  assert.ok(res.ok,'public ZIP HTTP '+res.status);
  const bytes=Buffer.from(await res.arrayBuffer());
  const digest=sha(bytes);
  assert.equal(digest,'278924b6af78154c90e3efa9daf1ed8f8913ff74cd23fa4f599c78ffedb3cc49');
  const archive=path.join(root,'完整插件包.zip'); fs.writeFileSync(archive,bytes);
  const extracted=path.join(root,'永久 安装路径');
  unzip(archive,extracted);
  assert.ok(fs.existsSync(path.join(extracted,'使用教程.md')));
  const plugin=path.join(extracted,'rdk-robot-learning-platform');
  verify(plugin);
  const env={...process.env,RDK_PLUGIN_RUNTIME_CACHE:path.join(root,'运行时 缓存')};
  for (const key of Object.keys(env)) if (key.toLowerCase()==='path') delete env[key];
  env.PATH = mode==='download-node'
    ? [path.dirname(cmd),process.env.SystemRoot,path.dirname(powerShell)].join(path.delimiter)
    : [path.dirname(process.execPath),process.env.PATH].join(path.delimiter);
  if (mode==='download-node') {
    // Explorer launches .cmd files with the default Windows PowerShell module path,
    // independently of the GitHub Actions PowerShell 7 process.
    for (const key of Object.keys(env)) if (key.toLowerCase()==='psmodulepath') delete env[key];
    const commands=run(powerShell,['-NoLogo','-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; (Get-Command Get-FileHash,Expand-Archive).Name"],{env});
    console.log('Default Windows PowerShell commands: '+commands.trim().replace(/\r?\n/g,', '));
  }
  const output=run(cmd,['/d','/c','setup-qoder-windows.cmd'],{cwd:plugin,env,input:'\r\n'});
  const installed=output.split(/\r?\n/).find(line=>line.startsWith('{"pluginVersion"'));
  assert.equal(JSON.parse(installed).pluginVersion,'0.6.8');
  assert.equal(JSON.parse(installed).credentialsStored,false);
  const imported=path.join(root,'Qoder 导入展开');
  unzip(path.join(plugin,'Qoder本机导入包.zip'),imported);
  const importRoot=path.join(imported,'rdk-robot-learning-platform');
  verify(importRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(importRoot,'.qoder-plugin/plugin.json'),'utf8')).version,'0.6.8');
  const entry=JSON.parse(fs.readFileSync(path.join(importRoot,'.mcp.json'),'utf8')).mcpServers['rdk-learning-platform'];
  assert.equal(entry.args[0],path.join(plugin,'scripts/experience-mcp.mjs'));
  assert.equal(entry.env.RDK_STUDIO_INHERIT_LOGIN,'0');
  assert.ok(!JSON.stringify(entry).includes('RDK_SIM2REAL_MCP_COOKIE'));
  if(mode==='download-node') assert.ok(entry.command.startsWith(env.RDK_PLUGIN_RUNTIME_CACHE + path.sep));
  const {connectMcp,readToolResult}=await import(pathToFileURL(path.join(plugin,'scripts/experience.mjs')).href);
  client=connectMcp({...entry,env:{...process.env,...entry.env},timeoutMs:20000});
  await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Qoder',version:'windows-release-smoke'}});
  client.notify('notifications/initialized');
  const tools=await client.request('tools/list');
  assert.ok(tools.tools.some(t=>t.name==='rdk_workshop'));
  const call=async(name,arguments_={})=>readToolResult(await client.request('tools/call',{name,arguments:arguments_}));
  const status=await call('rdk_plugin_status');
  assert.equal(status.pluginRuntime.version,'0.6.8');
  assert.equal(status.pluginRuntime.loadedSourcesMatch,true);
  const workshop=await call('rdk_workshop',{intent:'start'});
  assert.equal(workshop.stage,'preview');
  assert.equal(workshop.links.workshop,'https://rdkstudio.d-robotics.cc/robotics-learning/workshop.html?start=1');
  assert.equal(workshop.submission.training,false);
  assert.equal(workshop.submission.evaluation,false);
  const preview=await fetch(workshop.links.workshop,{signal:AbortSignal.timeout(20000)});
  assert.equal(preview.status,200);
  assert.match(await preview.text(),/id="workshop-setup-confirm"/);
  console.log(JSON.stringify({passed:true,mode,platform:process.platform,arch:process.arch,release:'0.6.8',digest,node:run(entry.command,['-v']).trim(),unicodePaths:true,qoderZip:true,retainedCoreMcp:true,livePreview:true}));
} finally {
  if (client) await client.close();
  fs.rmSync(root,{recursive:true,force:true});
}
