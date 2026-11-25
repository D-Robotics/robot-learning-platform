import { createHash } from 'node:crypto';
import type { OriginmanReferenceTrajectory } from '../../shared/originman-reference-training.js';

export const REFERENCE_DIGEST_VERSION = 'originman-reference-f64be-v1';

/** Hash trajectory values independently of the JSON number formatting used by the sender. */
export function originmanReferenceDigest(trajectory: OriginmanReferenceTrajectory): string {
  const hash = createHash('sha256').update(REFERENCE_DIGEST_VERSION + '\0');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(trajectory.fps);
  header.writeUInt32BE(trajectory.joint_pos.length, 4);
  hash.update(header);
  for (const name of trajectory.joint_names) hash.update(name + '\0');
  const data = Buffer.alloc(trajectory.joint_names.length * 8);
  for (const frames of [trajectory.joint_pos, trajectory.joint_vel]) {
    for (const row of frames) {
      row.forEach((value, index) => data.writeDoubleBE(value === 0 ? 0 : value, index * 8));
      hash.update(data);
    }
  }
  return hash.digest('hex');
}
