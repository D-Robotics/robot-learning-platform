#!/usr/bin/env node
import { spawnSync } from 'node:child_process'; import fs from 'node:fs';
const args=process.argv.slice(2); const n=args.find(x=>/^\d+$/.test(x))||'50'; const oi=args.indexOf('--out'); const out=oi>=0?args[oi+1]:null;
const r=spawnSync('python3',['engines/rdk-rl-env/generate_originbot_telemetry.py',n],{encoding:'utf8'}); if(r.status!==0){process.stderr.write(r.stderr);process.exit(r.status??1)}
if(out){fs.writeFileSync(out,r.stdout);console.error(`[originbot-demo] wrote ${r.stdout.trim().split('\n').filter(Boolean).length} samples to ${out}`)} else process.stdout.write(r.stdout);
