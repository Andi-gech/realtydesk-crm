/**
 * Disk-backed media cache served through the `media://` Tauri protocol.
 *
 * Avatars and chat photos are downloaded as base64 data URLs from Telegram.
 * Instead of keeping those strings in memory and localStorage, we hand them
 * to the Rust shell once, which writes the bytes to disk and returns a
 * `media://` URL pointing at the file. The webview then loads the image
 * directly from disk, keeping the JS heap small.
 */

import { invoke } from '@tauri-apps/api/core';

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = 15000
): Promise<T | null> {
  if (!isTauriEnvironment()) return null;
  try {
    return await Promise.race([
      invoke<T>(cmd, args).catch((err) => {
        console.warn(`[mediaStore] invoke('${cmd}') failed:`, err);
        return null;
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/** Build a webview-loadable URL for a file stored in the media cache. */
export function mediaUrl(fileName: string): string {
  const encoded = encodeURIComponent(fileName);
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
    return `http://media.localhost/${encoded}`;
  }
  return `media://localhost/${encoded}`;
}

/** Store a data URL on disk and return its `media://` URL (or null outside Tauri). */
export async function storeMediaDataUrl(key: string, dataUrl: string): Promise<string | null> {
  if (!isTauriEnvironment() || !dataUrl || !dataUrl.startsWith('data:')) return null;
  const fileName = await safeInvoke<string>('media_store', { key, data: dataUrl });
  if (!fileName) return null;
  return mediaUrl(fileName);
}
