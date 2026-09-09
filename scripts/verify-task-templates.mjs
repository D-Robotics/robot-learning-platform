import fs from 'node:fs'; import path from 'node:path';
const files=fs.readdirSync('tasks').filter(x=>x.endsWith('.json')); if(!files.length) throw Error('no task templates');
for(const f of files){const v=JSON.parse(fs.readFileSync(path.join('tasks',f)));if(v.schemaVersion!==1||!v.id||!v.adapterId||!v.reward||!v.termination||!Array.isArray(v.evaluation))throw Error(`${f}: invalid task template`);}
console.log(`[task-templates] PASS — ${files.length} templates validated`);
