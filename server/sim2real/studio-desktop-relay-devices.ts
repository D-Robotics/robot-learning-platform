import type { Device } from '../../shared/types.js';
import { studioDesktopRelay } from './studio-desktop-relay.js';

/** Presence is scoped to the authenticated owner and never stores local SSH
 * coordinates in the cloud registry. It expires with its outbound connector.
 */
export function appendDesktopRelayDevices<T extends Device>(
  devices: T[],
  owner?: string,
): Array<T | (Device & { bridgeOwnerKey: string })> {
  if (!owner) return devices;
  const known = new Set(devices.map((device) => device.id));
  const observedAt = new Date().toISOString();
  return [
    ...devices,
    ...studioDesktopRelay
      .devices(owner)
      .filter((device) => !known.has(device.id))
      .map((device) => ({
        ...device,
        host: 'studio-local',
        username: 'studio',
        lastCheckedAt: observedAt,
        connectionMode: 'bridge' as const,
        bridgeId: 'studio-desktop-relay',
        bridgeDeviceId: device.id,
        bridgeTransport: 'ssh' as const,
        bridgeOwnerKey: `sso:${owner}:web`,
      })),
  ];
}

export function hasDesktopRelay(owner?: string): boolean {
  return (
    !!owner && studioDesktopRelay.devices(owner).some((device) => device.status === 'connected')
  );
}
