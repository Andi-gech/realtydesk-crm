import { TelegramClient, Api } from 'telegram';
import { getInputMedia } from 'telegram/Utils';
import { NewMessage } from 'telegram/events';
import { Raw } from 'telegram/events';
import { getActiveTelegramClient, reconnect } from './telegram';
import { downloadAndCacheAvatar, getCachedAvatar, bufferToDataUrl } from './avatarCache';
import { api } from '../api/client';

export interface LiveChat {
  _id: string;
  externalChatId: string;
  telegramAccountId: string;
  title: string;
  contactName: string;
  contactId: {
    _id?: string;
    displayName: string;
    savedName?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    phoneNumber?: string;
    avatarUrl?: string;
    telegramUserId?: string;
    isBlocked?: boolean;
    duplicateFlag?: boolean;
  };
  agentId?: {
    _id?: string;
    displayName?: string;
  };
  lastMessageAt?: string;
  lastMessagePreview?: string;
  unreadCount: number;
  isArchived: boolean;
  isBlocked: boolean;
  entity: any;
  inputEntity?: any;
}

export interface LiveMessage {
  _id: string;
  telegramMessageId: string;
  direction: 'in' | 'out';
  senderType: 'contact' | 'agent' | 'owner';
  senderId?: string;
  text?: string;
  mediaRef?: string;
  sentAt: string;
  rawMedia?: any;
  replyToMsgId?: string;
  replyQuoteText?: string;
  groupedId?: string;
}

export interface FetchMessagesResult {
  messages: LiveMessage[];
  total?: number;
  hasMore: boolean;
  oldestId?: number;
}

// Timeout helper for async MTProto calls. Generous defaults so low-bandwidth
// connections are not falsely treated as offline.
const withTimeout = <T>(promise: Promise<T>, ms = 8000): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.allSettled(workers);
}

/** Returns true when text contains a Telegram link (e.g. t.me/... or https://t.me/...). */
export function containsTmeLink(text?: string | null): boolean {
  if (!text) return false;
  return /(?:https?:\/\/)?t\.me\//i.test(text);
}

/**
 * Lightweight MTProto search for any message containing "t.me/" in a chat.
 * Propagates FLOOD_WAIT errors so callers can pause rate-limited scans.
 */
export async function searchChatForTmeLink(
  client: TelegramClient,
  peer: any
): Promise<boolean> {
  if (!client || !client.connected || !peer) return false;
  const resolvedPeer =
    typeof peer === 'string' && /^-?\d+$/.test(peer.trim())
      ? Number(peer.trim())
      : peer;
  const res: any = await client.getMessages(resolvedPeer, {
    search: 't.me/',
    limit: 1,
  });
  return Array.isArray(res) && res.length > 0;
}

/**
 * Connects to Telegram MTProto for the specified account and returns the active client.
 */
export async function getLiveClient(telegramAccountId: string): Promise<TelegramClient | null> {
  try {
    return await getActiveTelegramClient(telegramAccountId);
  } catch (err) {
    console.warn('[telegramLiveService] getLiveClient error:', err);
    return null;
  }
}

/**
 * Fetches all live dialogs directly from Telegram MTProto in real time.
 * Loads both active chats (folder 0) and archived chats (folder 1) so no conversations are missed.
 */
export async function fetchLiveTelegramChats(
  client: TelegramClient,
  telegramAccountId: string,
  limit = 500
): Promise<LiveChat[]> {
  if (!client || !client.connected) {
    console.warn('[telegramLiveService] Client not connected for account:', telegramAccountId);
    return [];
  }

  try {
    // 1. Get blocked contacts from Telegram in the BACKGROUND (do not block
    // dialog loading). Results are merged in when available.
    const blockedUserIds = new Set<string>();
    (async () => {
      try {
        const blockedRes: any = await withTimeout(
          client.invoke(new (Api as any).contacts.GetBlocked({ offset: 0, limit: 100 })),
          4000
        );
        if (blockedRes?.blocked && Array.isArray(blockedRes.blocked)) {
          for (const b of blockedRes.blocked) {
            const pid = b.peerId?.userId || b.peerId?.chatId || b.peerId?.channelId || b.userId;
            if (pid) blockedUserIds.add(String(pid));
          }
        }
      } catch {}
    })();

    // 2. Fetch main dialogs first (fast), then archived (best-effort, short
    // timeout) without letting the archived batch gate the main result.
    const mainLimit = Math.min(limit, 60);
    const archivedLimit = Math.min(limit, 20);
    const mainDialogs = await withTimeout(client.getDialogs({ limit: mainLimit }), 20000)
      .then((r) => r || [])
      .catch(() => []);
    let archivedDialogs: any[] = [];
    try {
      archivedDialogs = await withTimeout(
        client.getDialogs({ folder: 1, limit: archivedLimit }),
        5000
      )
        .then((r) => r || [])
        .catch(() => []);
    } catch {}

    // Explicitly tag any dialog that comes from the archived folder
    if (Array.isArray(archivedDialogs)) {
      for (const ad of archivedDialogs) {
        (ad as any)._isArchivedFromTelegram = true;
      }
    }

    // Deduplicate dialogs
    const seenIds = new Set<string>();
    const dialogs: any[] = [];
    for (const d of [...(mainDialogs || []), ...(archivedDialogs || [])]) {
      const idStr = String(d.id);
      if (!seenIds.has(idStr)) {
        seenIds.add(idStr);
        dialogs.push(d);
      }
    }


    const liveChats: LiveChat[] = [];

    for (let i = 0; i < dialogs.length; i++) {
      const dialog = dialogs[i];
      try {
        const externalChatId = String(dialog.id);
        const entity: any = dialog.entity;
        if (!externalChatId) continue;

        const isArchived = Boolean(
          (dialog as any)._isArchivedFromTelegram ||
          (dialog as any).archived ||
          (dialog as any).folderId === 1 ||
          (dialog as any).folder?.id === 1 ||
          (dialog as any).dialog?.folderId === 1
        );

        // Accurate real-name resolution:
        // If saved in Telegram address book (entity.contact === true), dialog.title or entity name is what was saved
        const fullName = [entity?.firstName, entity?.lastName].filter(Boolean).join(' ').trim();
        const dialogTitle = (dialog.title || dialog.name || '').trim();
        const isContactSaved = Boolean(entity?.contact);
        const savedName = isContactSaved ? (dialogTitle || fullName || undefined) : undefined;
        const displayName = savedName || fullName || dialogTitle || (entity?.username ? `@${entity.username.replace(/^@/, '')}` : 'Telegram Contact');
        const username = entity?.username ? entity.username.replace(/^@/, '') : undefined;
        const isBlocked = blockedUserIds.has(String(entity?.id || '')) || blockedUserIds.has(externalChatId);

        // Avatar photo
        let avatarUrl: string | undefined = getCachedAvatar(externalChatId) || undefined;
        if (!avatarUrl && entity && (entity.photo || entity.className === 'User' || entity.className === 'Chat')) {
          // Download in background without blocking loop
          if (i < 20) {
            downloadAndCacheAvatar(client, entity, externalChatId).catch(() => {});
          }
        }

        // Preview text
        let preview = '';
        if (dialog.message) {
          if (dialog.message.message) {
            preview = dialog.message.message;
          } else if (dialog.message.media) {
            preview = '[Photo]';
          }
        }

        const lastMessageAt = dialog.date ? new Date(dialog.date * 1000).toISOString() : undefined;

        liveChats.push({
          _id: externalChatId,
          externalChatId,
          telegramAccountId,
          title: displayName,
          contactName: displayName,
          contactId: {
            displayName,
            savedName,
            firstName: entity?.firstName || undefined,
            lastName: entity?.lastName || undefined,
            username,
            phoneNumber: entity?.phone ? (entity.phone.startsWith('+') ? entity.phone : `+${entity.phone}`) : undefined,
            avatarUrl,
            telegramUserId: entity?.id ? String(entity.id) : undefined,
            isBlocked,
          },
          lastMessageAt,
          lastMessagePreview: preview,
          unreadCount: dialog.unreadCount || 0,
          isArchived,
          isBlocked,
          entity,
          inputEntity: dialog.inputEntity,
        });
      } catch (dErr) {
        console.warn('[telegramLiveService] Error parsing live dialog:', dErr);
      }
    }

    // Sort newest messages first
    liveChats.sort((a, b) => {
      const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return timeB - timeA;
    });

    // Hydrate remaining avatars progressively in background
    setTimeout(() => {
      for (let i = 20; i < dialogs.length; i++) {
        const d = dialogs[i];
        if (d?.entity && !getCachedAvatar(String(d.id))) {
          downloadAndCacheAvatar(client, d.entity, String(d.id)).catch(() => {});
        }
      }
    }, 1500);

    return liveChats;
  } catch (err) {
    console.error('[telegramLiveService] Error fetching live dialogs:', err);
    return [];
  }
}

/**
 * Fetches real-time message history directly from Telegram MTProto for a chat.
 * Supports pagination via offsetId to load the entire conversation history.
 */
export async function fetchLiveTelegramMessages(
  client: TelegramClient,
  peer: any,
  options: {
    limit?: number;
    offsetId?: number;
  } | number = 100,
  onMediaDownloaded?: (msgId: string, dataUrl: string) => void
): Promise<FetchMessagesResult> {
  if (!client || !client.connected || !peer) return { messages: [], hasMore: false };

  const limit = typeof options === 'number' ? options : (options?.limit || 100);
  const offsetId = typeof options === 'object' ? options?.offsetId : undefined;

  // GramJS treats numeric strings (e.g. "123456789" or "-1001234567890") as
  // usernames unless converted to a number, which causes getMessages to fail
  // when chat.entity isn't attached yet.
  const resolvedPeer =
    typeof peer === 'string' && /^-?\d+$/.test(peer.trim())
      ? Number(peer.trim())
      : peer;

  try {
    const rawMessages: any = await withTimeout(
      client.getMessages(resolvedPeer, { limit, offsetId }),
      25000
    );
    if (!rawMessages || !Array.isArray(rawMessages)) {
      return { messages: [], hasMore: false };
    }

    const total = typeof (rawMessages as any).total === 'number' ? (rawMessages as any).total : undefined;
    const hasMore = rawMessages.length >= limit;

    const messages: LiveMessage[] = [];
    const mediaToDownload: Array<{ m: any; msgId: string }> = [];
    let minId: number | undefined = undefined;

    for (const m of rawMessages) {
      if (!m || !m.id) continue;
      const numId = Number(m.id);
      if (minId === undefined || numId < minId) {
        minId = numId;
      }

      const msgId = String(m.id);
      const isOut = Boolean(m.out);
      const text = m.message || '';
      const sentAt = new Date((m.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      const liveMsg: LiveMessage = {
        _id: msgId,
        telegramMessageId: msgId,
        direction: isOut ? 'out' : 'in',
        senderType: isOut ? 'agent' : 'contact',
        senderId: m.senderId ? String(m.senderId) : undefined,
        text,
        sentAt,
        rawMedia: m.media,
        replyToMsgId: m.replyTo?.replyToMsgId ? String(m.replyTo.replyToMsgId) : undefined,
        replyQuoteText: m.replyTo?.quoteText || undefined,
        groupedId: m.groupedId ? String(m.groupedId) : undefined,
      };

      if (m.media) {
        mediaToDownload.push({ m, msgId });
      }

      messages.push(liveMsg);
    }

    // Download media in background with limited concurrency for low-network performance.
    if (mediaToDownload.length > 0) {
      void runWithConcurrency(mediaToDownload, 3, async ({ m, msgId }) => {
        try {
          const buf = await withTimeout(client.downloadMedia(m, {}), 6000);
          if (buf && (buf as any).length > 0) {
            const dataUrl = bufferToDataUrl(buf);
            if (dataUrl && onMediaDownloaded) {
              onMediaDownloaded(msgId, dataUrl);
            }
          }
        } catch {}
      });
    }

    // Telegram getMessages returns newest first; reverse so oldest is at top
    messages.reverse();

    return {
      messages,
      total,
      hasMore,
      oldestId: minId,
    };
  } catch (err) {
    console.warn('[telegramLiveService] Error fetching live messages:', err);
    return { messages: [], hasMore: false };
  }
}

/**
 * Sends a message directly to Telegram MTProto in real time.
 */
export interface SendLiveMessageOptions {
  text?: string;
  files?: File[];
  caption?: string;
  replyTo?: number;
}

export async function sendTelegramFilesRaw(
  client: TelegramClient,
  peer: any,
  files: File[],
  options: { caption?: string; replyTo?: number; forceDocument?: boolean } = {}
): Promise<any[]> {
  const inputFiles = (files || []).filter(Boolean).map((f, i) => {
    if (f instanceof File && f.name) return f;
    try { return new File([f], `photo-${i + 1}.jpg`, { type: (f as any)?.type || 'image/jpeg' }); } catch { return f; }
  });
  const caption = String(options.caption || '').trim();
  const replyTo = options.replyTo ? Number(options.replyTo) : undefined;

  let result: any;
  if (inputFiles.length === 1) {
    result = await client.sendFile(peer, {
      file: inputFiles[0],
      caption: caption || undefined,
      forceDocument: Boolean(options.forceDocument),
      ...(replyTo ? { replyTo } : {}),
    } as any);
  } else {
    const inputPeer = await client.getInputEntity(peer);
    const multiMedia: any[] = [];
    const randomIds: bigint[] = [];
    for (let i = 0; i < inputFiles.length; i++) {
      const f = inputFiles[i];
      const isImage = !options.forceDocument && /^image\//i.test(f.type || '') && !/gif/i.test(f.type || '');
      const uploaded = await client.uploadFile({ file: f, workers: 1 } as any);

      let media: any;
      if (isImage) {
        media = new Api.InputMediaUploadedPhoto({ file: uploaded } as any);
      } else {
        media = new Api.InputMediaUploadedDocument({
          file: uploaded,
          mimeType: f.type || 'application/octet-stream',
          attributes: [new Api.DocumentAttributeFilename({ fileName: f.name || `file-${i + 1}` })],
        } as any);
      }

      try {
        const r = await client.invoke(new Api.messages.UploadMedia({ peer: inputPeer, media } as any));
        if (r instanceof Api.MessageMediaPhoto && r.photo && !(r.photo instanceof Api.PhotoEmpty)) {
          const normalized = getInputMedia(r.photo);
          if (normalized) media = normalized;
        } else if (r instanceof Api.MessageMediaDocument && r.document && !(r.document instanceof Api.DocumentEmpty)) {
          const normalized = getInputMedia(r.document);
          if (normalized) media = normalized;
        }
      } catch {}

      if (!media) throw new Error('Failed to prepare media for album upload');
      const randomId = BigInt.asIntN(64, BigInt(Date.now() + i) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000)));
      randomIds.push(randomId);
      multiMedia.push(new Api.InputSingleMedia({ media, message: i === 0 ? caption : '', randomId } as any));
    }

    const replyObject = replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo } as any) : undefined;
    const updates = await client.invoke(new Api.messages.SendMultiMedia({
      peer: inputPeer,
      multiMedia,
      ...(replyObject ? { replyTo: replyObject } : {}),
    } as any));

    const extracted = (client as any)._getResponseMessage
      ? (client as any)._getResponseMessage(randomIds, updates, inputPeer)
      : null;
    result = extracted || updates;
  }

  if (Array.isArray(result)) return result;
  if (result?.updates) {
    const msgs = result.updates.map((u: any) => u?.message).filter(Boolean);
    if (msgs.length) return msgs;
  }
  if (result?.id) return [result];
  return [result];
}

export async function sendLiveTelegramMessage(
  client: TelegramClient,
  peer: any,
  textOrOptions: string | SendLiveMessageOptions
): Promise<LiveMessage[]> {
  const opts: SendLiveMessageOptions =
    typeof textOrOptions === 'string' ? { text: textOrOptions } : (textOrOptions || {});
  const text = (opts.text ?? opts.caption ?? '').trim();
  const files = (opts.files || []).filter(Boolean);
  const replyTo = opts.replyTo ? Number(opts.replyTo) : undefined;

  let results: any[];
  if (files.length > 0) {
    results = await sendTelegramFilesRaw(client, peer, files, { caption: text, replyTo, forceDocument: false });
  } else {
    const result = await client.sendMessage(peer, { message: text, ...(replyTo ? { replyTo } : {}) } as any);
    results = Array.isArray(result) ? result : [result];
  }

  const sentAt = new Date().toISOString();
  return results.map((r: any, idx: number) => {
    const msgId = String(r?.id || `${Date.now()}-${idx}`);
    return {
      _id: msgId,
      telegramMessageId: msgId,
      direction: 'out' as const,
      senderType: 'agent' as const,
      text: idx === 0 ? text : '',
      sentAt: r?.date ? new Date(r.date * 1000).toISOString() : sentAt,
      replyToMsgId: replyTo ? String(replyTo) : undefined,
      groupedId: r?.groupedId ? String(r.groupedId) : undefined,
    };
  });
}

export async function sendLiveTelegramTemplate(
  client: TelegramClient,
  peer: any,
  template: any,
  replyTo?: number
): Promise<LiveMessage[]> {
  const text = String(template?.body || '').trim();
  const mediaItems = Array.isArray(template?.media) ? template.media : [];
  if (mediaItems.length === 0) {
    return sendLiveTelegramMessage(client, peer, { text, replyTo });
  }

  const base64ToBytes = (b64?: string) => {
    if (!b64) return new Uint8Array();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const dataUrlToFile = async (dataUrl: string, name: string, mime: string) => {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], name, { type: mime || blob.type || 'image/jpeg' });
  };

  const inputPeer = await client.getInputEntity(peer);
  const replyObject = replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo } as any) : undefined;

  const savedMessageIds = Array.isArray(template?.savedMessageIds)
    ? template.savedMessageIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (savedMessageIds.length > 0) {
    try {
      const fwd: any = await (client as any).forwardMessages(inputPeer, {
        messages: savedMessageIds,
        fromPeer: 'me',
        dropAuthor: true,
        ...(replyTo ? { replyTo } : {}),
      });
      const fwdMsgs = Array.isArray(fwd) ? fwd : (fwd?.updates ? fwd.updates.map((u: any) => u?.message).filter(Boolean) : (fwd?.id ? [fwd] : []));
      if (fwdMsgs.length > 0) {
        return fwdMsgs.map((r: any, idx: number) => ({
          _id: String(r?.id || `${Date.now()}-${idx}`),
          telegramMessageId: String(r?.id || `${Date.now()}-${idx}`),
          direction: 'out' as const,
          senderType: 'agent' as const,
          text: idx === 0 ? (String(r?.message || text || '')) : '',
          sentAt: r?.date ? new Date(r.date * 1000).toISOString() : new Date().toISOString(),
          replyToMsgId: replyTo ? String(replyTo) : undefined,
          groupedId: r?.groupedId ? String(r.groupedId) : undefined,
        }));
      }
    } catch (err) {
      console.warn('[telegramLiveService] Template forward failed, falling back:', err);
    }
  }

  const toBigIntSafe = (v: any) => {
    try {
      if (v === undefined || v === null || v === '') return null;
      return BigInt(String(v));
    } catch { return null; }
  };

  const buildInputMedia = (m: any): Api.TypeInputMedia | null => {
    const id = toBigIntSafe(m?.id);
    const accessHash = toBigIntSafe(m?.accessHash);
    if (m?.kind === 'photo' && id !== null && accessHash !== null) {
      return new Api.InputMediaPhoto({
        id: new Api.InputPhoto({
          id,
          accessHash,
          fileReference: base64ToBytes(m.fileReference),
        } as any),
      } as any);
    }
    if (m?.kind === 'document' && id !== null && accessHash !== null) {
      return new Api.InputMediaDocument({
        id: new Api.InputDocument({
          id,
          accessHash,
          fileReference: base64ToBytes(m.fileReference),
        } as any),
      } as any);
    }
    return null;
  };

  const sendFromRefs = async () => {
    const medias = mediaItems.map(buildInputMedia).filter(Boolean) as Api.TypeInputMedia[];
    if (medias.length !== mediaItems.length) throw new Error('Missing media refs');
    if (medias.length === 1) {
      const r = await client.invoke(new Api.messages.SendMedia({
        peer: inputPeer,
        media: medias[0],
        message: text,
        randomId: BigInt.asIntN(64, BigInt(Date.now()) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000))),
        ...(replyObject ? { replyTo: replyObject } : {}),
      } as any));
      return r;
    }
    const multiMedia = medias.map((media, i) => new Api.InputSingleMedia({
      media,
      message: i === 0 ? text : '',
      randomId: BigInt.asIntN(64, BigInt(Date.now() + i) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000))),
    } as any));
    return client.invoke(new Api.messages.SendMultiMedia({
      peer: inputPeer,
      multiMedia,
      ...(replyObject ? { replyTo: replyObject } : {}),
    } as any));
  };

  let result: any;
  try {
    result = await sendFromRefs();
  } catch (err) {
    // Fallback: re-upload from stored dataUrl if refs expired/missing.
    const files: File[] = [];
    for (let i = 0; i < mediaItems.length; i++) {
      const m = mediaItems[i];
      if (m?.dataUrl) {
        files.push(await dataUrlToFile(String(m.dataUrl), m.fileName || `template-${i + 1}.jpg`, m.mimeType || 'image/jpeg'));
      }
    }
    if (files.length === 0) throw err;
    result = await sendLiveTelegramMessage(client, peer, { text, files, replyTo });
    const sent = Array.isArray(result) ? result : [result];
    return sent.map((r: any, idx: number) => ({
      _id: String(r?.id || r?.telegramMessageId || `${Date.now()}-${idx}`),
      telegramMessageId: String(r?.telegramMessageId || r?.id || `${Date.now()}-${idx}`),
      direction: 'out' as const,
      senderType: 'agent' as const,
      text: idx === 0 ? text : '',
      sentAt: r?.sentAt || new Date().toISOString(),
      replyToMsgId: replyTo ? String(replyTo) : undefined,
      groupedId: r?.groupedId ? String(r.groupedId) : undefined,
    }));
  }

  // Extract message objects from Updates
  let messages: any[] = [];
  if (Array.isArray(result)) messages = result;
  else if (result?.updates) {
    for (const u of result.updates) {
      if (u?.message) messages.push(u.message);
    }
  } else if (result?.message) {
    messages = [result.message];
  } else if (result?.id) {
    messages = [result];
  }
  if (messages.length === 0) {
    messages = [{ id: Date.now(), date: Math.floor(Date.now() / 1000) }];
  }

  return messages.map((r: any, idx: number) => ({
    _id: String(r?.id || `${Date.now()}-${idx}`),
    telegramMessageId: String(r?.id || `${Date.now()}-${idx}`),
    direction: 'out' as const,
    senderType: 'agent' as const,
    text: idx === 0 ? text : '',
    sentAt: r?.date ? new Date(r.date * 1000).toISOString() : new Date().toISOString(),
    replyToMsgId: replyTo ? String(replyTo) : undefined,
    groupedId: r?.groupedId ? String(r.groupedId) : undefined,
  }));
}

/**
 * Returns every id shape a message peer can take: raw MTProto ids (positive)
 * and the "bot API" marked ids GramJS uses for `dialog.id`
 * (`-chatId` for groups, `-100channelId` for channels). Comparing both shapes
 * is required — the old code only compared the raw id, so group/channel
 * messages never matched the chat row.
 */
export function getMessagePeerIds(message: any): string[] {
  const ids: string[] = [];
  const push = (value: any) => {
    if (value === undefined || value === null) return;
    const s = String(value);
    if (s && s !== '0' && !ids.includes(s)) ids.push(s);
  };

  const peer = message?.peerId;
  if (peer) {
    if (peer.channelId !== undefined && peer.channelId !== null) {
      push(`-100${peer.channelId}`);
      push(peer.channelId);
    } else if (peer.chatId !== undefined && peer.chatId !== null) {
      push(`-${peer.chatId}`);
      push(peer.chatId);
    } else if (peer.userId !== undefined && peer.userId !== null) {
      push(peer.userId);
    }
  }

  // Short updates and some forwarded payloads only carry chatId/senderId.
  push(message?.chatId);
  if (ids.length === 0) push(message?.senderId);
  return ids;
}

/** True when a chat row matches any of the peer id shapes. */
export function chatMatchesPeer(chat: any, peerIds: string[]): boolean {
  if (!chat || peerIds.length === 0) return false;
  const candidates = [
    chat.externalChatId,
    chat._id,
    chat.entity?.id,
    chat.contactId?.telegramUserId,
  ]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(String);
  return peerIds.some((id) => candidates.includes(id));
}

export type LiveStatus = 'live' | 'connecting' | 'waiting' | 'offline';

export interface LiveSubscriptionOptions {
  /** Needed so the subscription can reconnect on its own. */
  accountId?: string;
  onStatus?: (status: LiveStatus) => void;
  /** Called after a dropped connection is restored, so callers can catch up. */
  onReconnect?: () => void;
  /** How often to verify the socket is still alive. */
  watchdogMs?: number;
  /** Fired when Telegram reports that messages were read (inbox or outbox). */
  onReadHistory?: (peerIds: string[], stillUnreadCount: number | undefined) => void;
}

/**
 * Subscribes to live real-time Telegram updates using GramJS event handlers.
 *
 * The subscription is self-healing: it watches the socket, reconnects the same
 * client instance (preserving handlers) when it drops, and re-attaches to a
 * replacement client if one had to be created. This is what keeps the inbox
 * live like the normal Telegram app instead of silently going stale.
 */
export function subscribeLiveTelegramUpdates(
  client: TelegramClient | null,
  onNewMessage: (msg: any, peerId: string, peerIds: string[]) => void,
  options: LiveSubscriptionOptions = {}
): () => void {
  let activeClient: TelegramClient | null = client;
  let stopped = false;
  let reconnecting = false;
  let handlerAttached = false;
  let rawHandlerAttached = false;
  let wasLive = Boolean(client?.connected);
  // Exponential backoff for reconnect attempts so a flaky/low network is not
  // hammered (and falsely reported offline) on every watchdog tick.
  let failureCount = 0;
  let nextRetryAt = 0;

  const handler = (event: any) => {
    try {
      const message = event?.message;
      if (!message) return;
      const peerIds = getMessagePeerIds(message);
      onNewMessage(message, peerIds[0] || '', peerIds);
    } catch (err) {
      console.warn('[telegramLiveService] Error in live update handler:', err);
    }
  };

  const rawHandler = (update: any) => {
    try {
      const cls = update?.className || update?.constructor?.name || '';
      if (cls !== 'UpdateReadHistoryInbox' && cls !== 'UpdateReadHistoryOutbox') return;
      const peerIds = getMessagePeerIds({ peerId: update?.peer });
      if (peerIds.length === 0) return;
      const stillUnread = (typeof update?.stillUnreadCount === 'number')
        ? update.stillUnreadCount
        : undefined;
      options.onReadHistory?.(peerIds, stillUnread);
    } catch (err) {
      console.warn('[telegramLiveService] Error in read-history handler:', err);
    }
  };

  const attach = () => {
    if (!activeClient) return;
    if (!handlerAttached) {
      try {
        activeClient.addEventHandler(handler, new NewMessage({}));
        handlerAttached = true;
      } catch (err) {
        console.warn('[telegramLiveService] Could not attach update handler:', err);
      }
    }
    if (!rawHandlerAttached) {
      try {
        activeClient.addEventHandler(rawHandler, new Raw({ types: [Api.UpdateReadHistoryInbox, Api.UpdateReadHistoryOutbox] }));
        rawHandlerAttached = true;
      } catch (err) {
        console.warn('[telegramLiveService] Could not attach read-history handler:', err);
      }
    }
  };

  const detach = () => {
    if (!activeClient) return;
    if (handlerAttached) {
      try { activeClient.removeEventHandler(handler, new NewMessage({})); } catch {}
      handlerAttached = false;
    }
    if (rawHandlerAttached) {
      try { activeClient.removeEventHandler(rawHandler, new Raw({ types: [Api.UpdateReadHistoryInbox, Api.UpdateReadHistoryOutbox] })); } catch {}
      rawHandlerAttached = false;
    }
  };

  const isOsOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

  const ensureLive = async () => {
    if (stopped || reconnecting) return;
    if (isOsOffline()) {
      wasLive = false;
      options.onStatus?.('waiting');
      return;
    }
    // Exponential backoff: do not retry a reconnect before its scheduled time.
    if (Date.now() < nextRetryAt) {
      if (!activeClient?.connected) options.onStatus?.('connecting');
      return;
    }
    if (activeClient?.connected) {
      if (!handlerAttached || !rawHandlerAttached) attach();
      if (!wasLive) {
        wasLive = true;
        failureCount = 0;
        nextRetryAt = 0;
        options.onStatus?.('live');
        options.onReconnect?.();
      }
      return;
    }

    reconnecting = true;
    wasLive = false;
    options.onStatus?.('connecting');
    try {
      const next = options.accountId
        ? await getActiveTelegramClient(options.accountId)
        : null;
      if (!next || !next.connected) {
        failureCount = Math.min(failureCount + 1, 6);
        nextRetryAt = Date.now() + Math.min(20_000, 1000 * Math.pow(2, Math.min(failureCount - 1, 4))) + Math.round(Math.random() * 500);
        options.onStatus?.(isOsOffline() ? 'waiting' : 'connecting');
        return;
      }
      if (next !== activeClient) {
        detach();
        activeClient = next;
      }
      attach();
      wasLive = true;
      failureCount = 0;
      nextRetryAt = 0;
      options.onStatus?.('live');
      options.onReconnect?.();
    } catch (err) {
      console.warn('[telegramLiveService] Live reconnect failed:', err);
      failureCount = Math.min(failureCount + 1, 6);
      nextRetryAt = Date.now() + Math.min(20_000, 1000 * Math.pow(2, Math.min(failureCount - 1, 4))) + Math.round(Math.random() * 500);
      options.onStatus?.(isOsOffline() ? 'waiting' : 'connecting');
    } finally {
      reconnecting = false;
    }
  };

  if (client?.connected) {
    attach();
    options.onStatus?.('live');
  } else {
    options.onStatus?.(isOsOffline() ? 'waiting' : 'connecting');
    void ensureLive();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleWatchdog = () => {
    if (stopped) return;
    const ms = activeClient?.connected ? (options.watchdogMs ?? 15_000) : 5_000;
    timer = setTimeout(() => {
      void ensureLive().finally(scheduleWatchdog);
    }, ms);
  };
  scheduleWatchdog();
  const onOnline = () => {
    nextRetryAt = 0;
    failureCount = 0;
    wasLive = false;
    void ensureLive();
  };
  const onOffline = () => {
    wasLive = false;
    options.onStatus?.('waiting');
  };
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      nextRetryAt = 0;
      wasLive = false;
      void ensureLive();
    }
  };
  try {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
  } catch {}

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    } catch {}
    detach();
  };
}

/**
 * Builds a `LiveChat` for a peer that is not in the list yet (a brand-new
 * client messaging for the first time). Fetching the entity lets the inbox
 * show the conversation instantly instead of waiting for a full dialog reload.
 */
export async function buildLiveChatFromPeer(
  client: TelegramClient,
  telegramAccountId: string,
  peer: any,
  seedMessage?: any
): Promise<LiveChat | null> {
  try {
    const entity: any = await client.getEntity(peer);
    if (!entity) return null;

    const externalChatId = String(await client.getPeerId(entity));
    const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
    const dialogTitle = (entity.title || '').trim();
    const username = entity.username ? String(entity.username).replace(/^@/, '') : undefined;
    const isContactSaved = Boolean(entity?.contact);
    const savedName = isContactSaved ? (dialogTitle || fullName || undefined) : undefined;
    const displayName = savedName || fullName || dialogTitle || (username ? `@${username}` : 'Telegram Contact');

    let avatarUrl = getCachedAvatar(externalChatId) || undefined;
    if (entity.photo) {
      downloadAndCacheAvatar(client, entity, externalChatId).catch(() => {});
    }

    const sentAt = seedMessage?.date
      ? new Date(seedMessage.date * 1000).toISOString()
      : new Date().toISOString();

    return {
      _id: externalChatId,
      externalChatId,
      telegramAccountId,
      title: displayName,
      contactName: displayName,
      contactId: {
        displayName,
        savedName,
        firstName: entity.firstName || undefined,
        lastName: entity.lastName || undefined,
        username,
        phoneNumber: entity.phone
          ? (String(entity.phone).startsWith('+') ? String(entity.phone) : `+${entity.phone}`)
          : undefined,
        avatarUrl,
        telegramUserId: entity.id ? String(entity.id) : undefined,
        isBlocked: false,
      },
      lastMessageAt: sentAt,
      lastMessagePreview: seedMessage?.message || (seedMessage?.media ? '[Photo]' : ''),
      unreadCount: seedMessage && !seedMessage.out ? 1 : 0,
      isArchived: false,
      isBlocked: false,
      entity,
      inputEntity: (entity as any).inputEntity,
    };
  } catch (err) {
    console.warn('[telegramLiveService] Could not build chat from peer:', err);
    return null;
  }
}

/**
 * Background silent sync to MongoDB so CRM notes, tags, and contacts are preserved.
 * Runs completely non-blocking without delaying the user interface.
 *
 * Messages are debounced per chat (~400ms) and batched into a single sync
 * request. Failed flushes are retried once and, on continued failure, queued
 * for a later flush (see flushMirrorQueue).
 */
interface MirrorQueueEntry {
  telegramAccountId: string;
  chat: LiveChat;
  messages: LiveMessage[];
  timer?: ReturnType<typeof setTimeout>;
}

const mirrorQueue = new Map<string, MirrorQueueEntry>();

async function flushMirrorQueueEntry(key: string): Promise<void> {
  const entry = mirrorQueue.get(key);
  if (!entry || entry.messages.length === 0) {
    if (entry) entry.timer = undefined;
    return;
  }
  const toSend = entry.messages.slice(-15);
  const rest = entry.messages.slice(0, Math.max(0, entry.messages.length - toSend.length));
  entry.messages = rest;
  entry.timer = undefined;

  const payload = {
    telegramAccountId: entry.telegramAccountId,
    chatExternalId: entry.chat.externalChatId,
    contact: {
      telegramUserId: entry.chat.contactId?.telegramUserId,
      username: entry.chat.contactId?.username,
      phoneNumber: entry.chat.contactId?.phoneNumber,
      displayName: entry.chat.contactId?.displayName,
      savedName: entry.chat.contactId?.savedName,
      firstName: entry.chat.contactId?.firstName,
      lastName: entry.chat.contactId?.lastName,
      avatarUrl: entry.chat.contactId?.avatarUrl,
      isBlocked: entry.chat.isBlocked,
    },
    isArchived: entry.chat.isArchived,
    messages: toSend.map((m) => ({
      telegramMessageId: m.telegramMessageId,
      direction: m.direction,
      senderType: m.senderType,
      senderId: m.senderId,
      text: m.text,
      mediaRef: m.mediaRef,
      sentAt: m.sentAt,
    })),
  };

  const send = () => api.syncMessages(payload as any);
  try {
    await send();
  } catch {
    try {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await send();
    } catch {
      const cur = mirrorQueue.get(key);
      if (cur) {
        cur.messages = [...toSend, ...cur.messages];
      } else {
        mirrorQueue.set(key, {
          telegramAccountId: entry.telegramAccountId,
          chat: entry.chat,
          messages: toSend,
        });
      }
      return;
    }
  }

  const cur = mirrorQueue.get(key);
  if (cur && cur.messages.length > 0 && !cur.timer) {
    cur.timer = setTimeout(() => {
      void flushMirrorQueueEntry(key);
    }, 400);
  }
}

export function flushMirrorQueue(): void {
  for (const key of mirrorQueue.keys()) {
    const entry = mirrorQueue.get(key);
    if (entry && entry.messages.length > 0 && !entry.timer) {
      entry.timer = setTimeout(() => {
        void flushMirrorQueueEntry(key);
      }, 200);
    }
  }
}

export async function mirrorLiveChatToCRM(
  telegramAccountId: string,
  chat: LiveChat,
  messages: LiveMessage[] = []
): Promise<void> {
  const key = `${telegramAccountId}:${chat.externalChatId}`;
  const entry = mirrorQueue.get(key) || {
    telegramAccountId,
    chat,
    messages: [],
  };
  entry.chat = chat;
  entry.messages = [...entry.messages, ...messages];
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    void flushMirrorQueueEntry(key);
  }, 400);
  mirrorQueue.set(key, entry);
  return;
}