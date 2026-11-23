import { TelegramClient, Api } from 'telegram';
import { NewMessage } from 'telegram/events';
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
}

export interface FetchMessagesResult {
  messages: LiveMessage[];
  total?: number;
  hasMore: boolean;
  oldestId?: number;
}

// Timeout helper for async MTProto calls
const withTimeout = <T>(promise: Promise<T>, ms = 4000): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

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
    // 1. Get blocked contacts from Telegram so they are accurately tagged
    const blockedUserIds = new Set<string>();
    try {
      const blockedRes: any = await withTimeout(
        client.invoke(new (Api as any).contacts.GetBlocked({ offset: 0, limit: 100 })),
        2000
      );
      if (blockedRes?.blocked && Array.isArray(blockedRes.blocked)) {
        for (const b of blockedRes.blocked) {
          const pid = b.peerId?.userId || b.peerId?.chatId || b.peerId?.channelId || b.userId;
          if (pid) blockedUserIds.add(String(pid));
        }
      }
    } catch {}

    // 2. Fetch dialogs directly from Telegram MTProto (both main folder and archived folder 1)
    console.log(`[telegramLiveService] Loading live dialogs from Telegram for account: ${telegramAccountId}...`);
    const [mainDialogs, archivedDialogs] = await Promise.all([
      client.getDialogs({ limit }),
      client.getDialogs({ folder: 1, limit: 100 }).catch(() => []),
    ]);

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

    console.log(`[telegramLiveService] Received ${dialogs.length} total dialogs (${mainDialogs?.length || 0} active, ${archivedDialogs?.length || 0} archived).`);

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
  if (!client || !client.connected) return { messages: [], hasMore: false };

  const limit = typeof options === 'number' ? options : (options?.limit || 100);
  const offsetId = typeof options === 'object' ? options?.offsetId : undefined;

  try {
    const rawMessages: any = await client.getMessages(peer, {
      limit,
      offsetId,
    });
    if (!rawMessages || !Array.isArray(rawMessages)) {
      return { messages: [], hasMore: false };
    }

    const total = typeof (rawMessages as any).total === 'number' ? (rawMessages as any).total : undefined;
    const hasMore = rawMessages.length >= limit;

    const messages: LiveMessage[] = [];
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
      };

      // Download photo media asynchronously
      if (m.media) {
        withTimeout(client.downloadMedia(m, {}), 3500)
          .then((buf) => {
            if (buf && (buf as any).length > 0) {
              const dataUrl = bufferToDataUrl(buf);
              if (dataUrl && onMediaDownloaded) {
                onMediaDownloaded(msgId, dataUrl);
              }
            }
          })
          .catch(() => {});
      }

      messages.push(liveMsg);
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
export async function sendLiveTelegramMessage(
  client: TelegramClient,
  peer: any,
  text: string
): Promise<LiveMessage> {
  const result = await client.sendMessage(peer, { message: text });
  const msgId = String(result?.id || Date.now());
  const sentAt = new Date().toISOString();

  return {
    _id: msgId,
    telegramMessageId: msgId,
    direction: 'out',
    senderType: 'agent',
    text,
    sentAt,
  };
}

/**
 * Subscribes to live real-time Telegram updates using GramJS event handlers.
 * Instant notifications when any message arrives or is sent.
 */
export function subscribeLiveTelegramUpdates(
  client: TelegramClient,
  onNewMessage: (msg: any, peerId: string) => void
): () => void {
  if (!client || !client.connected) return () => {};

  const handler = (event: any) => {
    try {
      const message = event.message;
      if (!message) return;
      const peerId = String(
        message.peerId?.userId ||
        message.peerId?.chatId ||
        message.peerId?.channelId ||
        message.chatId ||
        message.senderId ||
        ''
      );
      onNewMessage(message, peerId);
    } catch (err) {
      console.warn('[telegramLiveService] Error in live update handler:', err);
    }
  };

  client.addEventHandler(handler, new NewMessage({}));

  return () => {
    try {
      client.removeEventHandler(handler, new NewMessage({}));
    } catch {}
  };
}

/**
 * Background silent sync to MongoDB so CRM notes, tags, and contacts are preserved.
 * Runs completely non-blocking without delaying the user interface.
 */
export async function mirrorLiveChatToCRM(
  telegramAccountId: string,
  chat: LiveChat,
  messages: LiveMessage[] = []
): Promise<void> {
  try {
    await api.syncMessages({
      telegramAccountId,
      chatExternalId: chat.externalChatId,
      contact: {
        telegramUserId: chat.contactId?.telegramUserId,
        username: chat.contactId?.username,
        phoneNumber: chat.contactId?.phoneNumber,
        displayName: chat.contactId?.displayName,
        savedName: chat.contactId?.savedName,
        firstName: chat.contactId?.firstName,
        lastName: chat.contactId?.lastName,
        avatarUrl: chat.contactId?.avatarUrl,
        isBlocked: chat.isBlocked,
      },
      isArchived: chat.isArchived,
      messages: messages.slice(-15).map((m) => ({
        telegramMessageId: m.telegramMessageId,
        direction: m.direction,
        senderType: m.senderType,
        senderId: m.senderId,
        text: m.text,
        mediaRef: m.mediaRef,
        sentAt: m.sentAt,
      })),
    });
  } catch (err) {
    // Non-fatal, silent background sync
  }
}
