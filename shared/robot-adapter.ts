/** Platform adapter contract: new RDK devices implement this boundary only. */
export const ROBOT_ADAPTER_SCHEMA_VERSION = 1 as const;
export type RobotFamily = 'diff-drive' | 'omni-drive' | 'joint' | 'custom';
export interface RobotAdapterManifest {
  schemaVersion: typeof ROBOT_ADAPTER_SCHEMA_VERSION;
  id: string;
  displayName: string;
  family: RobotFamily;
  hardwareProfileId: string;
  simulation: { backend: 'kinematic' | 'gazebo' | 'isaac' | 'mujoco' | 'external'; entrypoint?: string };
  training: { observationSize: number; actionSize: number; controlHz: number; algorithm?: string[] };
  telemetry: { required: string[]; optional?: string[] };
  action: { kind: string; commandTopic: string; maxLinear?: number; maxAngular?: number };
}
export function validateRobotAdapterManifest(input: unknown): { valid: boolean; errors: string[]; manifest?: RobotAdapterManifest } {
  const e:string[]=[]; const v:any=input&&typeof input==='object'?input:{};
  if(v.schemaVersion!==1)e.push('schemaVersion must be 1');
  if(!/^[a-z][a-z0-9-]{1,63}$/.test(String(v.id??'')))e.push('id must be a lowercase slug');
  for(const k of ['displayName','hardwareProfileId'])if(!String(v[k]??'').trim())e.push(`${k} is required`);
  if(!['diff-drive','omni-drive','joint','custom'].includes(v.family))e.push('family is invalid');
  if(!v.simulation||!['kinematic','gazebo','isaac','mujoco','external'].includes(v.simulation.backend))e.push('simulation.backend is invalid');
  if(!v.training||!Number.isInteger(v.training.observationSize)||!Number.isInteger(v.training.actionSize)||!(v.training.controlHz>0&&v.training.controlHz<=100))e.push('training dimensions/frequency are invalid');
  if(!v.telemetry||!Array.isArray(v.telemetry.required))e.push('telemetry.required is required');
  if(!v.action||!String(v.action.commandTopic??'').startsWith('/'))e.push('action.commandTopic must be absolute');
  return e.length?{valid:false,errors:e}:{valid:true,errors:e,manifest:v as RobotAdapterManifest};
}
