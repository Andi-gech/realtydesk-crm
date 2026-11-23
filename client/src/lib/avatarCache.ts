/**
 * Local Avatar cache & helper for Telegram profile photos.
 * Keeps an in-memory cache and localStorage fallback so real avatar images
 * render instantly across component re-renders.
 */

const memoryCache = new Map<string, string>();
const listeners = new Set<(id: string, dataUrl: string) => void>();
const inFlight = new Map<string, Promise<string | null>>();

export function subscribeAvatarUpdates(cb: (id: string, dataUrl: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emitAvatarUpdate(id: string, dataUrl: string) {
  listeners.forEach((cb) => {
    try {
      cb(id, dataUrl);
    } catch {}
  });
}

export function bufferToDataUrl(buf: any, mimeType = 'image/jpeg'): string | null {
  if (!buf || buf.length === 0) return null;
  try {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch (err) {
    console.warn('[avatarCache] bufferToDataUrl failed:', err);
    return null;
  }
}

export function getCachedAvatar(id?: string): string | null {
  if (!id) return null;
  const cleanId = String(id);
  if (memoryCache.has(cleanId)) {
    return memoryCache.get(cleanId)!;
  }
  try {
    const stored = localStorage.getItem(`realtydesk_av_${cleanId}`);
    if (stored) {
      memoryCache.set(cleanId, stored);
      return stored;
    }
  } catch {}
  return null;
}

export function setCachedAvatar(id: string, dataUrl: string): void {
  if (!id || !dataUrl) return;
  const cleanId = String(id);
  memoryCache.set(cleanId, dataUrl);
  try {
    localStorage.setItem(`realtydesk_av_${cleanId}`, dataUrl);
  } catch {}
  emitAvatarUpdate(cleanId, dataUrl);
}

/**
 * Downloads a profile photo for the given entity/peer from GramJS
 * and caches it in memory and localStorage.
 */
export async function downloadAndCacheAvatar(
  client: any,
  entity: any,
  id: string
): Promise<string | null> {
  if (!id) return null;
  const cleanId = String(id);

  // Return existing from cache
  const cached = getCachedAvatar(cleanId);
  if (cached) return cached;

  // Prevent duplicate concurrent requests for the same avatar
  if (inFlight.has(cleanId)) {
    return inFlight.get(cleanId)!;
  }

  const promise = (async () => {
    try {
      if (!client || !client.connected) return null;
      if (!entity) return null;

      // In GramJS, entity.photo indicates whether a profile photo is set
      if (typeof entity === 'object' && entity.photo === undefined && entity !== 'me') {
        return null;
      }

      // Download small thumbnail profile photo (timeout 3.5s)
      const downloadPromise = client.downloadProfilePhoto(entity, { isBig: false });
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500));

      const photoBuffer = await Promise.race([downloadPromise, timeoutPromise]);
      if (photoBuffer && photoBuffer.length > 0) {
        const dataUrl = bufferToDataUrl(photoBuffer);
        if (dataUrl) {
          setCachedAvatar(cleanId, dataUrl);
          return dataUrl;
        }
      }
    } catch (err) {
      // Privacy settings or user has no photo
    } finally {
      inFlight.delete(cleanId);
    }
    return null;
  })();

  inFlight.set(cleanId, promise);
  return promise;
}
