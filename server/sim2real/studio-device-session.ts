import type { Device } from '../../shared/types.js';

/** A signed Studio device cookie belongs to one client session. Resolve its
 * native device ID through Studio so reconnecting another client cannot move
 * this request to that client's registry entry. Studio retains admission. */
export async function studioDeviceSessionId(
  device: Pick<
    Device,
    | 'id'
    | 'connectionMode'
    | 'bridgeId'
    | 'bridgeDeviceId'
    | 'studioDeviceId'
    | 'host'
    | 'port'
    | 'username'
  >,
  origin: string | null,
  cookieHeader: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const fallback = String(device.studioDeviceId ?? device.bridgeDeviceId ?? device.id).trim();
  if (
    device.connectionMode !== 'bridge' ||
    device.bridgeId === 'studio-desktop' ||
    device.bridgeId === 'studio-desktop-relay' ||
    !/(?:^|;\s*)rdk_studio_devices=/.test(cookieHeader)
  )
    return fallback;
  if (!origin || cookieHeader.length > 16_384 || /[\u0000-\u001f\u007f]/.test(cookieHeader))
    return null;
  const abort = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  try {
    const response = await fetch(`${origin}/api/devices`, {
      headers: { accept: 'application/json', cookie: cookieHeader },
      redirect: 'error',
      signal: abort,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 256 * 1024) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { devices?: Device[] };
    if (!Array.isArray(value.devices)) return null;
    const matches = value.devices.filter(
      (item) =>
        item.connectionMode === 'bridge' &&
        item.bridgeId === device.bridgeId &&
        item.bridgeDeviceId === device.bridgeDeviceId &&
        item.host === device.host &&
        Number(item.port ?? 22) === Number(device.port ?? 22) &&
        (item.username ?? 'root') === (device.username ?? 'root') &&
        item.status === 'connected' &&
        typeof item.id === 'string' &&
        /^[A-Za-z0-9._:-]{1,160}$/.test(item.id),
    );
    return matches.length === 1 ? matches[0]!.id : null;
  } catch {
    return null;
  }
}
