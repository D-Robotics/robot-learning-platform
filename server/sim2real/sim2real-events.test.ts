import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSim2RealPluginsForTests,
  emitSim2RealEvent,
  listSim2RealPlugins,
  registerSim2RealPlugin,
} from './sim2real-events.js';

afterEach(() => clearSim2RealPluginsForTests());

describe('Sim2Real plugin event bus', () => {
  it('delivers typed events to matching plugins and keeps metadata private to server integrations', async () => {
    const received: unknown[] = [];
    registerSim2RealPlugin({
      id: 'experiment-tracker',
      events: ['run.created'],
      onEvent: (event) => received.push(event),
    });
    registerSim2RealPlugin({ id: 'all-events', events: '*', onEvent: (event) => received.push(event.type) });
    await emitSim2RealEvent('run.created', 'run-1', { status: 'queued' }, 'owner-a');
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: 'run.created', entityId: 'run-1', owner: 'owner-a', data: { status: 'queued' } });
    expect(listSim2RealPlugins()).toEqual([
      { id: 'experiment-tracker', events: ['run.created'] },
      { id: 'all-events', events: '*' },
    ]);
  });

  it('isolates handler failures and supports disposer replacement', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispose = registerSim2RealPlugin({ id: 'broken', events: '*', onEvent: () => { throw new Error('nope'); } });
    registerSim2RealPlugin({ id: 'healthy', events: '*', onEvent: () => undefined });
    await expect(emitSim2RealEvent('dataset.created', 'dataset-1', {})).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    dispose();
    expect(listSim2RealPlugins().map((item) => item.id)).toEqual(['healthy']);
    error.mockRestore();
  });

  it('serializes delivery for one plugin so tracker writes preserve event order', async () => {
    const seen: string[] = [];
    registerSim2RealPlugin({
      id: 'ordered',
      events: '*',
      onEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, event.entityId === 'first' ? 5 : 0));
        seen.push(event.entityId);
      },
    });
    const first = emitSim2RealEvent('run.created', 'first', {});
    const second = emitSim2RealEvent('run.updated', 'second', {});
    await Promise.all([first, second]);
    expect(seen).toEqual(['first', 'second']);
  });
});
