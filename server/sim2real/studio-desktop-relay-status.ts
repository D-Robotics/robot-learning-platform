import { studioDesktopRelay, type StudioDesktopRelayBroker } from './studio-desktop-relay.js';

/** Project live, account-owned connector presence. SSH configuration and
 * BoardAgent readiness are deliberately absent from this observation.
 */
export function desktopRelayBridgeStatus(
  owner: string | undefined,
  broker: Pick<StudioDesktopRelayBroker, 'hasOwnerSession' | 'devices'> = studioDesktopRelay,
) {
  if (!owner || !broker.hasOwnerSession(owner)) return null;
  return {
    available: true,
    provider: 'studio-desktop',
    state: 'ready',
    transport: 'studio-relay',
    bridges: [
      {
        bridgeId: 'studio-desktop-relay',
        provider: 'studio-desktop',
        online: true,
        devices: broker.devices(owner).map((device) => ({
          ...device,
          bridgeDeviceId: device.id,
          platformDeviceId: device.id,
          transport: 'studio-relay',
        })),
      },
    ],
  };
}
