import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('../../', import.meta.url);
const FILES = {
  'install.py': 'services/sim2real-web/worker-bootstrap/install.py',
  'worker.mjs': 'services/sim2real-web/local-training-worker.mjs',
  'engines/starter-ppo/runner.py': 'engines/starter-ppo/runner.py',
  'engines/reward_vocabulary.py': 'engines/reward_vocabulary.py',
};

/** The public payload contains source files only, with a digest-bound immutable URL. */
export function workerBootstrapBundle() {
  const files = Object.fromEntries(
    Object.entries(FILES).map(([name, source]) => [
      name,
      readFileSync(new URL(source, ROOT)).toString('base64'),
    ]),
  );
  const bytes = gzipSync(Buffer.from(JSON.stringify(files)));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function pythonCommand(program: string) {
  const encoded = Buffer.from(program).toString('base64');
  return `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`;
}

/** Only validated IDs, a deployment-owned public key and a trusted bundle URL reach SSH. */
export function workerDeployCommand(input: {
  id: string;
  port: number;
  listenHost: string;
  publicKey: string;
  bundleUrl: string;
  sha256: string;
}) {
  return pythonCommand(`import os,json,base64,gzip,hashlib,urllib.request,subprocess
from pathlib import Path
os.umask(0o077)
root=Path.home()/".local/share/rdk-learning/workers"/${JSON.stringify(input.id)}
root.mkdir(parents=True,exist_ok=True)
if root.is_symlink() or root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077: raise ValueError("private-root-required")
cfg=root/"config.json"
if not cfg.exists():
 with urllib.request.urlopen(${JSON.stringify(input.bundleUrl)},timeout=20) as r: data=r.read(2000001)
 if len(data)>2000000 or hashlib.sha256(data).hexdigest()!=${JSON.stringify(input.sha256)}: raise ValueError("bundle-digest")
 files=json.loads(gzip.decompress(data))
 if set(files)!=set(["install.py","worker.mjs","engines/starter-ppo/runner.py","engines/reward_vocabulary.py"]): raise ValueError("bundle-files")
 for name,content in files.items():
  target=root/name
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(base64.b64decode(content,validate=True))
 (root/"public.pem").write_text(${JSON.stringify(input.publicKey)})
 temporary=root/"config.pending"
 temporary.write_text(json.dumps({"port":${input.port},"id":${JSON.stringify(input.id)},"host":${JSON.stringify(input.listenHost)}}))
 os.replace(temporary,cfg)
log=(root/"install.log").open("ab")
subprocess.Popen(["python3",str(root/"install.py"),"install"],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print('RDK_WORKER_DEPLOYMENT={"state":"starting"}')
`);
}

export function workerStatusCommand(id: string) {
  return pythonCommand(`from pathlib import Path
import subprocess
p=Path.home()/".local/share/rdk-learning/workers"/${JSON.stringify(id)}/"install.py"
if p.is_file(): subprocess.run(["python3",str(p),"status"],check=True)
else: print('RDK_WORKER_DEPLOYMENT={"state":"missing"}')
`);
}
