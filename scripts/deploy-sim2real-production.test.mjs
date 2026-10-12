#!/usr/bin/env node
/** Exercise the real deployment shell against isolated command doubles. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./deploy-sim2real-production.sh', import.meta.url));
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sim2real-deploy-test-')));
const executable = (file, body) => writeFileSync(file, body, { mode: 0o755 });
const invoke = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

// All remote shell bodies execute unchanged in a temporary filesystem. Only
// the fixed production root argument is mapped; no real SSH or HTTP is used.
// SSH sends command text to the remote shell: empty arguments disappear and
// local arguments containing spaces are parsed again. Preserve that boundary.
const commandDouble = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
const name=path.basename(process.argv[1]);
const base=process.env.MOCK_REMOTE;
const log=event=>fs.appendFileSync(process.env.MOCK_LOG,event+'\\n');
const current=()=>fs.realpathSync(base+'/current');
const candidate=()=>!current().endsWith('/previous');
log(name+' '+args.join(' '));
if(name==='mktemp') {
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(process.env.MOCK_STAGE_LINK),'release-'));
  console.log(path.join(process.env.MOCK_STAGE_LINK,path.basename(directory)));
  process.exit(0);
}
if(name==='npm'&&args[0]==='ci') {
  if(args.includes('--prefix')||process.cwd()!==fs.realpathSync(process.cwd())||!fs.existsSync(path.join(process.cwd(),'dist-server'))) {
    console.error('Production install must run from the staged release directory');
    process.exit(1);
  }
  if(process.env.MOCK_FAIL==='npm') {
    console.error('Production dependency installation failed');
    process.exit(1);
  }
}
if(name==='npm'||name==='node'||name==='scp'||name==='sleep') process.exit(0);
if(name==='readlink') {
  console.log(args.at(-1).startsWith('/proc/')?process.env.MOCK_NODE:fs.realpathSync(args.at(-1)));
  process.exit(0);
}
if(name==='systemctl') {
  const unit=args[1];
  if(args[0]==='show') {
    const field=args[args.indexOf('-p')+1];
    if(field==='MainPID') console.log('999999');
    else if(field==='LoadState') console.log(process.env.MOCK_CPU==='no'?'not-found':'loaded');
    else if(field==='ExecStart') {
      const entry=unit==='sim2real-web.service'?'dist-server/services/sim2real-web/server.js':
        unit==='sim2real-mock-worker.service'?'mock-local-worker.mjs':'dist-server/services/sim2real-web/local-training-worker.mjs';
      console.log('{ path='+process.env.MOCK_NODE+' ; argv[]='+process.env.MOCK_NODE+' '+base+'/current/'+entry+' ; }');
    }
    process.exit(0);
  }
  if(args[0]==='restart'&&candidate()&&process.env.MOCK_FAIL==='restart'&&!fs.existsSync(process.env.MOCK_FAILED)) {
    fs.writeFileSync(process.env.MOCK_FAILED,'failed');
    process.exit(1);
  }
  if(args[0]==='is-active') console.log('active');
  process.exit(0);
}
if(name==='curl') {
  const url=args.at(-1);
  const check=url.includes(':19090/')?'mock-worker':url.includes(':19091/')?'cpu-worker':url.endsWith('/readyz')?'readyz':'healthz';
  process.stdout.write(candidate()&&process.env.MOCK_FAIL===check?'503':'200');
  process.exit(0);
}
if(name==='ssh') {
  const hostIndex=args.indexOf(process.env.DEPLOY_HOST);
  const command=args.slice(hostIndex+1).map(arg=>arg.replaceAll('/opt/sim2real-web',base));
  if(command[0]==='bash') {
    const body=fs.readFileSync(0,'utf8');
    if(process.env.MOCK_FAIL==='late-existing'&&body.includes('tar xzf')) {
      fs.mkdirSync(base+'/releases/'+command[3]);
      fs.writeFileSync(base+'/releases/'+command[3]+'/keep','immutable');
    }
    const result=spawnSync('/bin/bash',['-c',command.join(' ')],{input:body,encoding:'utf8',env:process.env});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
    process.exit(result.status??1);
  }
  const result=spawnSync('/bin/bash',['-c',command.join(' ')],{encoding:'utf8',env:process.env});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  process.exit(result.status??1);
}
throw Error('Unexpected double: '+name);
`;

function scenario(name, options = {}) {
  const home = path.join(root, name);
  const repo = path.join(home, 'repo');
  const remote = path.join(home, 'remote');
  const bin = path.join(home, 'bin');
  const stageReal = path.join(home, 'staging-real');
  const stageLink = path.join(home, 'staging-link');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(stageReal);
  invoke('ln', ['-s', stageReal, stageLink], repo);
  copyFileSync(source, path.join(repo, 'scripts/deploy-sim2real-production.sh'));
  writeFileSync(path.join(repo, '.gitignore'), 'dist-server/\n');
  writeFileSync(path.join(repo, 'package.json'), '{}\n');
  writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(repo, 'scripts/reify-deployment-optional-deps.mjs'), '// fixture\n');
  invoke('git', ['init', '-q'], repo);
  invoke('git', ['add', '.'], repo);
  invoke(
    'git',
    [
      '-c',
      'user.name=Deployment Test',
      '-c',
      'user.email=deployment@example.test',
      'commit',
      '-qm',
      name,
    ],
    repo,
  );
  const sha = invoke('git', ['rev-parse', '--short', 'HEAD'], repo);
  const date = invoke('date', ['+%Y%m%d'], repo);
  const release = `robot-learning-${date}-${sha}`;
  const publicDir = path.join(repo, 'dist-server/services/sim2real-web');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(path.join(publicDir, 'server.js'), '// fixture\n');
  writeFileSync(path.join(publicDir, 'mock-local-worker.mjs'), '// fixture\n');
  writeFileSync(path.join(publicDir, 'local-training-worker.mjs'), '// fixture\n');
  mkdirSync(path.join(remote, 'releases/previous/dist-server/engines'), { recursive: true });
  writeFileSync(path.join(remote, 'releases/previous/dist-server/engines/venv-lineage'), 'keep\n');
  invoke('ln', ['-s', 'releases/previous', path.join(remote, 'current')], repo);
  for (const command of [
    'ssh',
    'scp',
    'npm',
    'node',
    'systemctl',
    'curl',
    'readlink',
    'sleep',
    'mktemp',
  ]) {
    executable(path.join(bin, command), commandDouble);
  }
  if (options.existing) {
    mkdirSync(path.join(remote, 'releases', release));
    writeFileSync(path.join(remote, 'releases', release, 'keep'), 'immutable');
  }
  if (options.dirty === 'untracked')
    writeFileSync(path.join(repo, 'candidate.js'), '// uncommitted\n');
  if (options.dirty === 'tracked')
    writeFileSync(path.join(repo, 'package.json'), '{"dirty":true}\n');
  const logFile = path.join(home, 'commands.log');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DEPLOY_HOST: `deployment-${name}@example.test`,
    MOCK_REMOTE: remote,
    MOCK_STAGE_LINK: stageLink,
    MOCK_NODE: path.join(bin, 'node'),
    MOCK_LOG: logFile,
    MOCK_FAILED: path.join(home, 'failed-once'),
    MOCK_CPU: options.cpu === false ? 'no' : 'yes',
    MOCK_FAIL: options.fail || '',
  };
  delete env.DEPLOY_NODE_BIN;
  if (options.nodeOverride) env.DEPLOY_NODE_BIN = path.join(bin, 'node');
  const result = spawnSync('/bin/bash', ['scripts/deploy-sim2real-production.sh'], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const commands = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  rmSync(`/tmp/release-${sha}.tar.gz`, { force: true });
  const key = env.DEPLOY_HOST.replace(/[^A-Za-z0-9]/g, '_');
  rmSync(`/tmp/sim2real-deploy.${key}.lock.flock`, { force: true });
  return { result, commands, remote, release };
}

try {
  for (const dirty of ['tracked', 'untracked']) {
    const check = scenario(`dirty-${dirty}`, { dirty });
    assert.notEqual(check.result.status, 0, `${dirty} must block publication`);
    assert.match(check.result.stderr, /工作区含未提交或未跟踪文件/);
    assert.equal(check.commands, '', 'dirty source must stop before SSH or build');
  }
  for (const existing of ['early', 'late']) {
    const check = scenario(`existing-${existing}`, {
      existing: existing === 'early',
      fail: existing === 'late' ? 'late-existing' : '',
    });
    assert.notEqual(check.result.status, 0);
    assert.match(check.result.stderr, /release already exists/);
    assert.equal(
      readFileSync(path.join(check.remote, 'releases', check.release, 'keep'), 'utf8'),
      'immutable',
    );
    assert.equal(
      realpathSync(path.join(check.remote, 'current')),
      path.join(check.remote, 'releases/previous'),
    );
    if (existing === 'early') assert.doesNotMatch(check.commands, /npm run build|scp /);
  }
  for (const fail of ['restart', 'healthz', 'readyz', 'mock-worker', 'cpu-worker']) {
    const check = scenario(`failure-${fail}`, { fail });
    assert.notEqual(check.result.status, 0, `${fail} must fail publication`);
    assert.match(check.result.stderr, /自动回滚到上一 release/);
    assert.equal(
      realpathSync(path.join(check.remote, 'current')),
      path.join(check.remote, 'releases/previous'),
    );
    for (const unit of [
      'sim2real-web.service',
      'sim2real-mock-worker.service',
      'sim2real-cpu-worker.service',
    ]) {
      assert.match(check.commands, new RegExp(`systemctl restart ${unit}`));
    }
  }
  const installFailure = scenario('failure-npm', { fail: 'npm' });
  assert.notEqual(installFailure.result.status, 0);
  assert.match(installFailure.result.stderr, /Production dependency installation failed/);
  assert.equal(
    realpathSync(path.join(installFailure.remote, 'current')),
    path.join(installFailure.remote, 'releases/previous'),
  );
  assert.doesNotMatch(installFailure.commands, /scp |systemctl restart /);
  for (const cpu of [true, false]) {
    const check = scenario(cpu ? 'success-with-cpu' : 'success-without-cpu', {
      cpu,
      nodeOverride: !cpu,
    });
    assert.equal(check.result.status, 0, check.result.stderr || check.result.stdout);
    assert.equal(
      realpathSync(path.join(check.remote, 'current')),
      path.join(check.remote, 'releases', check.release),
    );
    assert.equal(
      readFileSync(
        path.join(check.remote, 'releases', check.release, 'dist-server/engines/venv-lineage'),
        'utf8',
      ),
      'keep\n',
    );
    assert.match(check.commands, /node --check .*server\.js/);
    assert.doesNotMatch(check.commands, /curl .*POST|19090\/train/);
    for (const unit of ['sim2real-web.service', 'sim2real-mock-worker.service']) {
      assert.match(check.commands, new RegExp(`systemctl show ${unit} -p ExecStart --value`));
      assert.match(check.commands, new RegExp(`systemctl restart ${unit}`));
    }
    assert.match(check.commands, /18102\/readyz/);
    assert.match(check.commands, /19090\/healthz/);
    if (cpu) {
      assert.match(
        check.commands,
        /systemctl show sim2real-cpu-worker\.service -p ExecStart --value/,
      );
      assert.match(check.commands, /systemctl restart sim2real-cpu-worker\.service/);
      assert.match(check.commands, /19091\/healthz/);
    } else {
      assert.doesNotMatch(
        check.commands,
        /systemctl restart sim2real-cpu-worker\.service|19091\/healthz/,
      );
    }
  }
  console.log(
    'Deployment safety: 12 isolated scenarios passed (dirty sources, immutable releases, dependency installation, rollback, Node, CPU compatibility).',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
