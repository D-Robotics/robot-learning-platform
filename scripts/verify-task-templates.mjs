import fs from 'node:fs'; import path from 'node:path';
const files=fs.readdirSync('tasks').filter(x=>x.endsWith('.json')); if(!files.length) throw Error('no task templates');
function pair(v,where){if(!Array.isArray(v)||v.length!==2||!v.every(x=>typeof x==='number'&&Number.isFinite(x))||v[0]>v[1])throw Error(`${where}: must be [min,max]`);}
const DR_KEYS=['motorGain','lagTauSeconds','gyroNoiseStdRadSec','odomNoiseStdM','angularBiasRadSec','actionLatencySteps','odomDropoutProb','slipScale'];
for(const f of files){
  const v=JSON.parse(fs.readFileSync(path.join('tasks',f)));
  if(v.schemaVersion!==1||!v.id||!v.adapterId||!v.reward||!v.termination||!Array.isArray(v.evaluation))throw Error(`${f}: invalid task template`);
  const r=v.reward;
  for(const k of ['progress','collision','goal','actionPenalty'])if(typeof r[k]!=='number'||!Number.isFinite(r[k]))throw Error(`${f}: reward.${k} must be a finite number`);
  const t=v.termination;
  if(!(t.goalDistance>0)||!(t.timeoutSteps>0))throw Error(`${f}: termination needs positive goalDistance/timeoutSteps`);
  const c=v.curriculum||{initialGoalDistance:[1,1.5],finalGoalDistance:[1,1.5]};
  pair(c.initialGoalDistance,`${f}: curriculum.initialGoalDistance`);pair(c.finalGoalDistance,`${f}: curriculum.finalGoalDistance`);
  if(!(c.expandFactor>1))throw Error(`${f}: curriculum.expandFactor must exceed 1`);
  const d=v.domainRandomization||{};
  for(const k of DR_KEYS)if(d[k])pair(d[k],`${f}: domainRandomization.${k}`);
  if(d.odomDropoutProb)if(!(d.odomDropoutProb[0]>=0&&d.odomDropoutProb[1]<=1))throw Error(`${f}: domainRandomization.odomDropoutProb must be a probability in [0,1]`);
  if(d.slipScale)if(!(d.slipScale[0]>0&&d.slipScale[1]<=1.5))throw Error(`${f}: domainRandomization.slipScale must be positive and near 1 (0 < min <= max <= 1.5)`);
  if(d.evalEnvelopes)for(const name of ['nominal','hard']){const e=d.evalEnvelopes[name];if(!Array.isArray(e)||![6,8].includes(e.length)||!e.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error(`${f}: domainRandomization.evalEnvelopes.${name} must be 6 or 8 numbers [motorGain, lagTauSeconds, gyroNoise, odomNoise, angularBias, latencySteps, (odomDropout, slipScale)]`);}
  const q=v.qualityGate||{};
  if(q.minSuccessRate!==undefined&&!(q.minSuccessRate>=0&&q.minSuccessRate<=1))throw Error(`${f}: qualityGate.minSuccessRate must be within [0,1]`);
  if(q.maxCollisionRate!==undefined&&!(q.maxCollisionRate>=0&&q.maxCollisionRate<=1))throw Error(`${f}: qualityGate.maxCollisionRate must be within [0,1]`);
  if(q.gateOn!==undefined&&q.gateOn!=='point'&&q.gateOn!=='ciLowerBound')throw Error(`${f}: qualityGate.gateOn must be "point" or "ciLowerBound"`);
  const ec=v.evaluationConfig||{};
  if(ec.episodesPerEnvelope!==undefined&&!(Number.isInteger(ec.episodesPerEnvelope)&&ec.episodesPerEnvelope>=1&&ec.episodesPerEnvelope<=200))throw Error(`${f}: evaluationConfig.episodesPerEnvelope must be an integer in [1,200]`);
  if(ec.confidenceLevel!==undefined&&![0.9,0.95,0.99].includes(ec.confidenceLevel))throw Error(`${f}: evaluationConfig.confidenceLevel must be 0.9/0.95/0.99`);
  if(q.gateOn==='ciLowerBound'&&ec.episodesPerEnvelope!==undefined&&ec.episodesPerEnvelope<30)throw Error(`${f}: gateOn=ciLowerBound with fewer than 30 episodes per envelope is statistically meaningless`);
  if(v.provenance&&v.provenance.mock!==true)throw Error(`${f}: provenance.mock must stay true — task packs never claim hardware validation they did not run`);
}
console.log(`[task-templates] PASS — ${files.length} templates validated`);
