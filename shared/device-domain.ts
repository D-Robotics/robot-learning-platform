export type DeviceStatus = 'discovered' | 'online' | 'offline' | 'blocked' | 'error';
export interface DeviceSummary {
  id: string;
  name: string;
  status: DeviceStatus;
  boardType?: string;
  heartbeatAt?: string;
  capabilities: string[];
}
export function deviceIsReady(
  d: Pick<DeviceSummary, 'status' | 'heartbeatAt'>,
  now = Date.now(),
): boolean {
  if (d.status !== 'online' || !d.heartbeatAt) return false;
  const t = Date.parse(d.heartbeatAt);
  return Number.isFinite(t) && t <= now && now - t < 120000;
}
