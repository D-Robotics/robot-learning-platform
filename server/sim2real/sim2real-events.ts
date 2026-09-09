import { randomUUID } from 'node:crypto';
import type { Sim2RealDomainEvent, Sim2RealDomainEventType } from '../../shared/sim2real-events.js';

export type Sim2RealEventHandler = (event: Sim2RealDomainEvent) => void | Promise<void>;

export interface Sim2RealPlugin {
  /** Stable id used for replacement and diagnostics. */
  id: string;
  events: readonly Sim2RealDomainEventType[] | '*';
  onEvent: Sim2RealEventHandler;
}

const MAX_PLUGINS = 32;
const plugins = new Map<string, Sim2RealPlugin>();
const pluginTails = new Map<string, Promise<void>>();

function validId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id);
}

/** Register (or replace) a process-local integration without changing core routes. */
export function registerSim2RealPlugin(plugin: Sim2RealPlugin): () => void {
  const id = String(plugin.id ?? '').trim();
  if (!validId(id)) throw new Error('sim2real_plugin_id_invalid');
  if (typeof plugin.onEvent !== 'function') throw new Error('sim2real_plugin_handler_invalid');
  if (plugins.size >= MAX_PLUGINS && !plugins.has(id)) throw new Error('sim2real_plugin_quota_exceeded');
  const normalized: Sim2RealPlugin = {
    id,
    events: plugin.events === '*' ? '*' : [...new Set(plugin.events)],
    onEvent: plugin.onEvent,
  };
  plugins.set(id, normalized);
  // Replacing a plugin starts a fresh delivery chain. Events already queued
  // for the old handler are allowed to finish through its captured closure.
  pluginTails.set(id, Promise.resolve());
  return () => {
    if (plugins.get(id) === normalized) {
      plugins.delete(id);
      pluginTails.delete(id);
    }
  };
}

export function listSim2RealPlugins(): Array<{ id: string; events: Sim2RealDomainEventType[] | '*' }> {
  return [...plugins.values()].map((plugin) => ({
    id: plugin.id,
    events: plugin.events === '*' ? '*' : [...plugin.events],
  }));
}

/**
 * Fire-and-forget by design: an optional integration must never make a model,
 * run or deployment write fail. Handler failures are isolated and reported to
 * stderr for operators. A snapshot makes register/unregister during delivery
 * deterministic.
 */
export async function emitSim2RealEvent<T>(
  type: Sim2RealDomainEventType,
  entityId: string,
  data: T,
  owner?: string,
): Promise<void> {
  const event: Sim2RealDomainEvent<T> = {
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    ...(owner ? { owner } : {}),
    entityId,
    data,
  };
  const deliveries = [...plugins.values()]
    .filter((plugin) => plugin.events === '*' || plugin.events.includes(type))
    .map((plugin) => {
      const previous = pluginTails.get(plugin.id) ?? Promise.resolve();
      const delivery = previous.then(async () => {
        try {
          await plugin.onEvent(event);
        } catch (error) {
          console.error(`[sim2real] plugin ${plugin.id} failed for ${type}:`, error instanceof Error ? error.message : error);
        }
      });
      pluginTails.set(plugin.id, delivery);
      return delivery;
    });
  await Promise.all(deliveries);
}

/** Test isolation hook; production callers should use the disposer returned by register. */
export function clearSim2RealPluginsForTests(): void {
  plugins.clear();
  pluginTails.clear();
}
