import { describe, expect, it } from 'vitest';
import { StudioDesktopRelayBroker } from './studio-desktop-relay.js';
import { desktopRelayBridgeStatus } from './studio-desktop-relay-status.js';
const device = { id: `studio-${'a'.repeat(24)}`, name: 'Local X5', status: 'connected' };
describe('live account-scoped Studio relay status projection', () => {
  it('expires local presence with the connector lease instead of retaining an online record', () => {
    let now = 1000;
    const broker = new StudioDesktopRelayBroker({ now: () => now, sessionTtlMs: 100 });
    broker.register('alice', [device]);
    expect(desktopRelayBridgeStatus('alice', broker)?.bridges[0].online).toBe(true);
    now += 101;
    expect(desktopRelayBridgeStatus('alice', broker)).toBeNull();
    broker.closeAll();
  });
  it('does not substitute another account for an empty or absent native catalog', () => {
    const broker = new StudioDesktopRelayBroker();
    broker.register('alice', [device]);
    broker.register('bob', []);
    expect(desktopRelayBridgeStatus('bob', broker)?.bridges[0].devices).toEqual([]);
    expect(desktopRelayBridgeStatus('carol', broker)).toBeNull();
    expect(desktopRelayBridgeStatus(undefined, broker)).toBeNull();
    broker.closeAll();
  });
});
