export type AtomicCapability = {
  id: string;
  description: string;
  readOnly?: boolean;
  execute: (input: unknown, context: Record<string, unknown>) => Promise<unknown>;
};
const capabilities = new Map<string, AtomicCapability>();
export function registerCapability(c: AtomicCapability) {
  if (!c.id || capabilities.has(c.id)) throw new Error(`Capability already registered: ${c.id}`);
  capabilities.set(c.id, c);
}
export function listCapabilities() {
  return [...capabilities.values()].map(({ id, description, readOnly }) => ({
    id,
    description,
    readOnly: readOnly === true,
  }));
}
export function getCapability(id: string) {
  return capabilities.get(id);
}
