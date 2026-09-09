#!/usr/bin/env node
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const p='/tmp/rdk-originbot-demo.jsonl'; const r=spawnSync('node',['scripts/demo-originbot.mjs','5','--out',p],{encoding:'utf8'}); if(r.status!==0) throw Error(r.stderr); const rows=fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse); if(rows.length!==5||rows.some(x=>x.source!=='originbot-sim'||!x.telemetry?.odom||!x.telemetry?.imu)) throw Error('invalid OriginBot telemetry'); fs.unlinkSync(p); console.log('[originbot-telemetry] PASS — JSONL generation and schema validated');
