/**
 * Local-first SQLite cache (desktop only).
 *
 * The server's MongoDB is the source of truth. This module talks to the
 * embedded SQLite database in the Tauri shell (WAL mode, optional FTS5) and
 * only caches data on the user's machine so the inbox and threads can paint
 * before the network answers and can be searched locally.
 *
 * Every function degrades silently outside Tauri (browser/dev preview), so the
 * app keeps working from localStorage/in-memory caches there.
 */

import { invoke, Channel } from '@tauri-apps/api/core';

const MAX_CACHED_CHATS = 400;
const MAX_CACHED_MESSAGES = 400;

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = 8000
): Promise<T | null> {
  if (!isTauriEnvironment()) return null;
  try {
    return await Promise.race([
      invoke<T>(cmd, args).catch((err) => {
        console.warn(`[localDb] invoke('${cmd}') failed:`, err);
        return null;
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/** Stable key shared by chat rows and message rows: `accountId:chatId`. */
export function chatCacheKey(chat: any): string {
  const accountId = String(chat?.telegramAccountId?._id || chat?.telegramAccountId || '');
  const chatId = String(chat?.externalChatId || chat?._id || '');
  return `${accountId}:${chatId}`;
}

function chatDisplayName(chat: any): string {
  if (!chat) return 'Telegram Contact';
  if (chat.contactId?.savedName?.trim()) return chat.contactId.savedName.trim();
  const first = chat.contactId?.firstName?.trim();
  const last = chat.contactId?.lastName?.trim();
  const fullName = [first, last].filter(Boolean).join(' ');
  if (fullName) return fullName;
  if (chat.contactId?.displayName?.trim() && !chat.contactId.displayName.startsWith('@')) {
    return chat.contactId.displayName.trim();
  }
  if (chat.title?.trim() && !chat.title.startsWith('@')) return chat.title.trim();
  if (chat.contactName?.trim() && !chat.contactName.startsWith('@')) return chat.contactName.trim();
  if (chat.contactId?.phoneNumber?.trim()) return chat.contactId.phoneNumber.trim();
  if (chat.contactId?.username?.trim()) return `@${chat.contactId.username.replace(/^@/, '')}`;
  return chat.title || 'Telegram User';
}

function stripChatForCache(chat: any): any {
  const { entity, inputEntity, ...rest } = chat || {};
  const contactId = rest.contactId
    ? {
        ...rest.contactId,
        // Base64 avatars are cached separately; don't duplicate them on disk.
        avatarUrl:
          typeof rest.contactId.avatarUrl === 'string' && rest.contactId.avatarUrl.startsWith('data:')
            ? undefined
            : rest.contactId.avatarUrl,
      }
    : rest.contactId;
  return { ...rest, contactId };
}

function stripMessageForCache(message: any): any {
  const { rawMedia, entity, inputEntity, ...rest } = message || {};
  // Data-URL photos can be hundreds of KB each; keep them out of the durable
  // cache and let the live fetch refill them when online.
  if (typeof rest.mediaRef === 'string' && rest.mediaRef.startsWith('data:') && rest.mediaRef.length > 1024) {
    rest.mediaRef = undefined;
  }
  return rest;
}

function parseRows(payloads: string[] | null): any[] {
  if (!payloads || payloads.length === 0) return [];
  const out: any[] = [];
  for (const raw of payloads) {
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Skip a corrupt row rather than dropping the whole cache.
    }
  }
  return out;
}

/** Upsert the current chat list into SQLite. */
export async function cacheChats(chats: any[]): Promise<void> {
  if (!Array.isArray(chats) || chats.length === 0) return;
  const rows: Array<Record<string, unknown>> = [];
  for (const chat of chats.slice(0, MAX_CACHED_CHATS)) {
    try {
      const light = stripChatForCache(chat);
      rows.push({
        key: chatCacheKey(chat),
        accountId: String(chat?.telegramAccountId?._id || chat?.telegramAccountId || '') || null,
        name: chatDisplayName(chat),
        preview: String(chat?.lastMessagePreview || ''),
        username: String(chat?.contactId?.username || ''),
        phone: String(chat?.contactId?.phoneNumber || ''),
        payload: JSON.stringify(light),
      });
    } catch {
      // A single non-serializable chat must not block the rest of the cache.
    }
  }
  if (rows.length === 0) return;
  await safeInvoke('cache_chats_replace', { rows }, 12000);
}

/** Load the cached chat list, newest first. Streams rows over a Channel. */
export async function loadCachedChats(limit = MAX_CACHED_CHATS): Promise<any[]> {
  if (!isTauriEnvironment()) {
    const rows = await safeInvoke<string[]>('cache_chats_load', { limit });
    return parseRows(rows);
  }
  const rows: string[] = [];
  const channel = new Channel<string>();
  channel.onmessage = (payload) => {
    rows.push(payload);
  };
  const result = await safeInvoke<null>('cache_chats_load_stream', { channel, limit }, 12000);
  if (result === null && rows.length === 0) {
    // Fall back to the array command if streaming failed.
    const fallback = await safeInvoke<string[]>('cache_chats_load', { limit });
    return parseRows(fallback);
  }
  return parseRows(rows);
}

/**
 * Full-text search over cached chats and messages. Returns chat keys.
 * Empty when FTS5 is unavailable or the query has no usable terms.
 */
export async function searchCachedChatIds(query: string, limit = 200): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await safeInvoke<string[]>('cache_chats_search', { query: q, limit });
  return rows || [];
}

/** Upsert a thread's messages. `replaceAll` rewrites the whole thread. */
export async function cacheMessages(
  chatKey: string,
  messages: any[],
  replaceAll = true
): Promise<void> {
  if (!chatKey || !Array.isArray(messages) || messages.length === 0) return;
  const recent = messages.slice(-MAX_CACHED_MESSAGES);
  const deduped = new Map<string, { chatKey: string; msgId: string; sentAt: number; text: string; payload: string }>();
  for (const message of recent) {
    try {
      const payload = stripMessageForCache(message);
      const msgId = String(message?.telegramMessageId || message?._id || '');
      if (!msgId) continue;
      const sentAt = new Date(message?.sentAt || 0).getTime() || 0;
      deduped.set(msgId, {
        chatKey,
        msgId,
        sentAt,
        text: String(message?.text || ''),
        payload: JSON.stringify(payload),
      });
    } catch {
      // Skip an individual non-serializable message.
    }
  }
  const finalRows = [...deduped.values()];
  if (finalRows.length === 0) return;
  await safeInvoke('cache_messages_put', { rows: finalRows, replaceAll }, 12000);
}

/** Load a thread's cached messages in chronological order. Streams rows over a Channel. */
export async function loadCachedMessages(
  chatKey: string,
  limit = MAX_CACHED_MESSAGES
): Promise<any[]> {
  if (!chatKey) return [];
  if (!isTauriEnvironment()) {
    const rows = await safeInvoke<string[]>('cache_messages_load', { chatKey, limit });
    return parseRows(rows);
  }
  const rows: string[] = [];
  const channel = new Channel<string>();
  channel.onmessage = (payload) => {
    rows.push(payload);
  };
  const result = await safeInvoke<null>('cache_messages_load_stream', { channel, chatKey, limit }, 12000);
  if (result === null && rows.length === 0) {
    const fallback = await safeInvoke<string[]>('cache_messages_load', { chatKey, limit });
    return parseRows(fallback);
  }
  return parseRows(rows);
}

/** Wipe the local cache (used by explicit "clear local data" actions). */
export async function clearLocalCache(): Promise<void> {
  await safeInvoke('cache_clear', {}, 12000);
}
