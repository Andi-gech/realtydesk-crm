import { TelegramClient, Api } from 'telegram';
import { api } from '../api/client';
import { reconnect, getActiveTelegramClient, setupUpdateListener } from './telegram';
import { saveSession } from './secureStorage';
import { downloadAndCacheAvatar, getCachedAvatar, bufferToDataUrl } from './avatarCache';

export interface SyncProgressCallback {
  (message: string): void;
}

const SYNC_KEY_PREFIX = 'realtydesk_last_sync_';

export function getLastSyncTime(accountId: string): number {
  try {
    const val = localStorage.getItem(`${SYNC_KEY_PREFIX}${accountId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

export function setLastSyncTime(accountId: string, timestamp: number): void {
  try {
    localStorage.setItem(`${SYNC_KEY_PREFIX}${accountId}`, String(timestamp));
  } catch {}
}

const activeListeners = new Set<string>();

// Timeout helper so async calls never hang
const withTimeout = <T>(promise: Promise<T>, ms = 2000): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

/**
 * Syncs dialogs and recent messages from a connected TelegramClient to the server.
 * When forceFull is false, performs a fast delta sync (updates only).
 */
export async function syncAccountChats(
  client: TelegramClient,
  telegramAccountId: string,
  onProgress?: SyncProgressCallback,
  forceFull = false,
  outgoingSenderType: 'agent' | 'owner' = 'agent'
): Promise<number> {
  if (!client || !client.connected) {
    console.warn('[telegramSync] Client not connected for account:', telegramAccountId);
    return 0;
  }

  try {
    // Download own profile photo in background if not yet cached
    downloadAndCacheAvatar(client, 'me', telegramAccountId).catch(() => {});

    const lastSync = forceFull ? 0 : getLastSyncTime(telegramAccountId);
    onProgress?.(lastSync > 0 ? 'Checking for new Telegram messages...' : 'Fetching all dialogs from Telegram...');
    console.log('[telegramSync] Loading dialogs for account:', telegramAccountId, { lastSync, forceFull });

    // Fetch up to 500 dialogs so no historical chats are omitted
    const dialogs = await client.getDialogs({ limit: 500 });
    console.log(`[telegramSync] Found ${dialogs.length} dialogs.`);

    if (!dialogs || dialogs.length === 0) {
      onProgress?.('No dialogs found on Telegram.');
      return 0;
    }

    // Query blocked contacts from Telegram so they are accurately labeled
    const blockedUserIds = new Set<string>();
    try {
      const blockedRes: any = await withTimeout(
        client.invoke(new (Api as any).contacts.GetBlocked({ offset: 0, limit: 100 })),
        2200
      );
      if (blockedRes && blockedRes.blocked && Array.isArray(blockedRes.blocked)) {
        for (const b of blockedRes.blocked) {
          const pid = b.peerId?.userId || b.peerId?.chatId || b.peerId?.channelId || b.userId;
          if (pid) blockedUserIds.add(String(pid));
        }
      }
    } catch (bErr) {
      console.warn('[telegramSync] Could not fetch blocked contacts:', bErr);
    }

    // All dialogs are targetDialogs to ensure 100% of chats are registered in CRM.
    // Detailed media & multi-message fetching is prioritized for recent active dialogs.
    const targetDialogs = dialogs;

    onProgress?.(`Syncing ${targetDialogs.length} Telegram chats...`);

    const items: Array<{
      chatExternalId: string;
      contact: {
        telegramUserId?: string;
        username?: string;
        displayName?: string;
        savedName?: string;
        firstName?: string;
        lastName?: string;
        phoneNumber?: string;
        avatarUrl?: string;
        isBlocked?: boolean;
      };
      isArchived?: boolean;
      unreadCount?: number;
      lastMessageAt?: string;
      lastMessagePreview?: string;
      messages: Array<{
        telegramMessageId: string;
        direction: 'in' | 'out';
        senderType: 'contact' | 'agent' | 'owner';
        senderId?: string;
        text?: string;
        mediaRef?: string;
        sentAt: string;
      }>;
    }> = [];

    for (let i = 0; i < targetDialogs.length; i++) {
      const dialog = targetDialogs[i];
      try {
        const chatExternalId = String(dialog.id);
        const entity: any = dialog.entity;
        const isArchived = Boolean((dialog as any).archived || (dialog as any).folderId === 1);

        // Accurate name resolution:
        // 1. If saved in Telegram address book (entity.contact == true), dialog.title or entity name is what we saved!
        // 2. Otherwise real profile name (firstName + lastName)
        // 3. Fallback to @username only if no name is available
        const fullName = [entity?.firstName, entity?.lastName].filter(Boolean).join(' ').trim();
        const dialogTitle = (dialog.title || dialog.name || '').trim();
        const isContactSaved = Boolean(entity?.contact);
        const savedName = isContactSaved ? (dialogTitle || fullName || undefined) : undefined;
        const displayName = savedName || fullName || dialogTitle || (entity?.username ? `@${entity.username.replace(/^@/, '')}` : undefined);
        const username = entity?.username ? entity.username.replace(/^@/, '') : undefined;
        const isBlocked = blockedUserIds.has(String(entity?.id || '')) || blockedUserIds.has(chatExternalId);

        // Fetch or load profile photo avatar
        let avatarUrl: string | undefined = getCachedAvatar(chatExternalId) || undefined;
        if (!avatarUrl && entity && (entity.photo || entity.className === 'User' || entity.className === 'Chat')) {
          try {
            const downloaded = await withTimeout(
              downloadAndCacheAvatar(client, entity, chatExternalId),
              1800
            );
            if (downloaded) avatarUrl = downloaded;
          } catch {}
        }

        const contact = {
          telegramUserId: entity?.id ? String(entity.id) : undefined,
          username,
          displayName,
          savedName,
          firstName: entity?.firstName || undefined,
          lastName: entity?.lastName || undefined,
          phoneNumber: entity?.phone
            ? entity.phone.startsWith('+')
              ? entity.phone
              : `+${entity.phone}`
            : undefined,
          avatarUrl,
          isBlocked,
        };

        let messages: Array<{
          telegramMessageId: string;
          direction: 'in' | 'out';
          senderType: 'contact' | 'agent' | 'owner';
          senderId?: string;
          text?: string;
          mediaRef?: string;
          sentAt: string;
        }> = [];

        // For the first 15 active chats, fetch recent history (up to 25 messages)
        if (i < 15) {
          try {
            const rawMessages = await withTimeout(
              client.getMessages(dialog.entity || dialog.inputEntity, { limit: 25 }),
              2500
            );
            if (rawMessages && Array.isArray(rawMessages)) {
              for (const m of rawMessages) {
                if (!m || !m.id || (!m.message && !m.media)) continue;
                let mediaRef: string | undefined = undefined;
                if (m.media) {
                  try {
                    const mediaBuf = await withTimeout(
                      client.downloadMedia(m, {}),
                      3500
                    );
                    if (mediaBuf && (mediaBuf as any).length > 0) {
                      mediaRef = bufferToDataUrl(mediaBuf) || undefined;
                    }
                  } catch (mErr) {
                    console.warn('[telegramSync] downloadMedia notice:', mErr);
                  }
                }
                messages.push({
                  telegramMessageId: String(m.id),
                  direction: m.out ? ('out' as const) : ('in' as const),
                  senderType: m.out ? outgoingSenderType : ('contact' as const),
                  senderId: m.senderId ? String(m.senderId) : undefined,
                  text: m.message || (mediaRef ? '' : m.media ? '[Photo]' : ''),
                  mediaRef,
                  sentAt: new Date(m.date * 1000).toISOString(),
                });
              }
            }
          } catch {
            // fallback to top message below
          }
        }

        // Fallback to dialog's top message
        if (messages.length === 0 && dialog.message && dialog.message.id) {
          let topMediaRef: string | undefined = undefined;
          if (dialog.message.media && i < 25) {
            try {
              const topBuf = await withTimeout(
                client.downloadMedia(dialog.message, {}),
                2500
              );
              if (topBuf && (topBuf as any).length > 0) {
                topMediaRef = bufferToDataUrl(topBuf) || undefined;
              }
            } catch {}
          }
          messages = [
            {
              telegramMessageId: String(dialog.message.id),
              direction: dialog.message.out ? ('out' as const) : ('in' as const),
              senderType: dialog.message.out ? outgoingSenderType : ('contact' as const),
              senderId: dialog.message.senderId ? String(dialog.message.senderId) : undefined,
              text: dialog.message.message || (topMediaRef ? '' : '[Photo]'),
              mediaRef: topMediaRef,
              sentAt: new Date(dialog.message.date * 1000).toISOString(),
            },
          ];
        }

        const lastMessageDate = dialog.date ? new Date(dialog.date * 1000).toISOString() : undefined;
        const lastMessageText = dialog.message?.message || (dialog.message?.media ? '[Photo]' : '');

        // Always push every dialog so 100% of chats exist in the CRM
        items.push({
          chatExternalId,
          contact,
          isArchived,
          unreadCount: dialog.unreadCount || 0,
          lastMessageAt: lastMessageDate,
          lastMessagePreview: lastMessageText,
          messages,
        });
      } catch (err) {
        console.warn('[telegramSync] Notice formatting dialog:', err);
      }
    }

    // Sync items in fast batches of 15 with real-time progress
    let syncedCount = 0;
    const batchSize = 15;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const startNum = i + 1;
      const endNum = Math.min(i + batch.length, items.length);

      onProgress?.(`Syncing updates ${startNum}–${endNum} of ${items.length}...`);

      try {
        await api.syncBatchMessages({
          telegramAccountId,
          items: batch,
        });
        syncedCount += batch.length;
      } catch (batchErr) {
        console.warn('[telegramSync] Batch sync notice, falling back to individual:', batchErr);
        for (const item of batch) {
          try {
            await api.syncMessages({
              telegramAccountId,
              ...item,
            });
            syncedCount++;
          } catch {}
        }
      }
    }

    setLastSyncTime(telegramAccountId, Date.now());
    console.log(`[telegramSync] Completed sync: ${syncedCount} chats synced.`);
    onProgress?.(syncedCount > 0 ? `Synced ${syncedCount} updated chats!` : 'All chats are up to date');

    // Progressively download avatars for any remaining dialogs in background
    hydrateRemainingDialogAvatars(client, dialogs);

    return syncedCount;
  } catch (err: any) {
    console.error('[telegramSync] Error syncing account dialogs:', err);
    throw err;
  }
}

/**
 * Progressively downloads avatars for dialogs in background so real photos
 * pop in smoothly without freezing or throttling.
 */
async function hydrateRemainingDialogAvatars(client: TelegramClient, dialogs: any[]): Promise<void> {
  if (!client || !client.connected || !dialogs) return;
  for (const d of dialogs) {
    try {
      const id = String(d.id);
      if (!getCachedAvatar(id) && d.entity && (d.entity.photo || d.entity.className === 'User' || d.entity.className === 'Chat')) {
        await downloadAndCacheAvatar(client, d.entity, id);
        // Stagger network calls slightly to avoid Telegram flood limits
        await new Promise((r) => setTimeout(r, 60));
      }
    } catch {}
  }
}

/**
 * Sets up a live listener on the TelegramClient so any incoming or outgoing
 * messages in real time get pushed to the server immediately.
 */
export function startLiveSync(
  client: TelegramClient,
  telegramAccountId: string,
  outgoingSenderType: 'agent' | 'owner' = 'agent'
): () => void {
  if (activeListeners.has(telegramAccountId)) {
    return () => {};
  }
  activeListeners.add(telegramAccountId);
  console.log('[telegramSync] Starting live message listener for account:', telegramAccountId);

  return setupUpdateListener(client, async (msg) => {
    try {
      console.log('[telegramSync] Live message event received:', msg.telegramMessageId);
      let mediaRef: string | undefined = undefined;
      if ((msg as any).media) {
        try {
          const mediaBuf = await withTimeout(client.downloadMedia(msg as any, {}), 3500);
          if (mediaBuf) mediaRef = bufferToDataUrl(mediaBuf) || undefined;
        } catch (e) {
          console.warn('[telegramSync] live media download error:', e);
        }
      }
      await api.syncMessages({
        telegramAccountId,
        chatExternalId: msg.chatExternalId,
        contact: {
          telegramUserId: msg.senderUserId || undefined,
        },
        messages: [
          {
            telegramMessageId: msg.telegramMessageId,
            direction: msg.direction,
            senderType: msg.direction === 'out' ? outgoingSenderType : 'contact',
            senderId: msg.senderUserId,
            text: msg.text || (mediaRef ? '' : ''),
            mediaRef,
            sentAt: msg.date.toISOString(),
          },
        ],
      });
      setLastSyncTime(telegramAccountId, Date.now());
    } catch (err) {
      console.warn('[telegramSync] Error pushing live message to server:', err);
    }
  });
}

/**
 * Reconnects to all active linked Telegram accounts on this device and syncs them.
 * Only the signed-in user's own accounts are synced; sessions never leave the
 * device, so the server cannot reconnect accounts on the user's behalf.
 * By default runs a delta sync (updates only). Set forceFull=true for full resync.
 */
export async function syncAllLinkedAccounts(
  onProgress?: SyncProgressCallback,
  forceFull = false
): Promise<number> {
  try {
    const { telegramAccounts } = await api.myTelegramAccounts();
    if (!telegramAccounts || telegramAccounts.length === 0) {
      console.log('[telegramSync] No linked telegram accounts found on server for user.');
      return 0;
    }

    let totalSynced = 0;
    for (const acc of telegramAccounts) {
      if (forceFull) {
        try {
          localStorage.removeItem(`${SYNC_KEY_PREFIX}${acc._id}`);
        } catch {}
      }
      const client = await reconnect(acc._id);
      if (client) {
        const outgoingSenderType = acc.ownerType === 'owner' ? 'owner' : 'agent';
        startLiveSync(client, acc._id, outgoingSenderType);
        const count = await syncAccountChats(
          client,
          acc._id,
          onProgress,
          forceFull,
          outgoingSenderType
        );
        totalSynced += count;
      } else {
        console.warn('[telegramSync] Could not reconnect to account:', acc._id);
      }
    }

    return totalSynced;
  } catch (err) {
    console.warn('[telegramSync] Error in syncAllLinkedAccounts:', err);
    return 0;
  }
}

/**
 * On-demand deep history fetch for an active chat. Pulls up to `limit` messages
 * directly from Telegram and syncs them to the server so the entire thread is available.
 */
export async function syncFullChatHistory(
  telegramAccountId: string,
  externalChatId: string,
  limit = 60
): Promise<boolean> {
  try {
    const client = await getActiveTelegramClient(telegramAccountId);
    if (!client || !client.connected) return false;

    const rawMessages = await withTimeout(
      client.getMessages(externalChatId, { limit }),
      4500
    );

    if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
      return false;
    }

    const messagesToSync: Array<{
      telegramMessageId: string;
      direction: 'in' | 'out';
      senderType: 'contact' | 'agent' | 'owner';
      senderId?: string;
      text?: string;
      mediaRef?: string;
      sentAt: string;
    }> = [];

    for (const m of rawMessages) {
      if (!m || !m.id || (!m.message && !m.media)) continue;
      let mediaRef: string | undefined = undefined;
      if (m.media) {
        try {
          const mediaBuf = await withTimeout(client.downloadMedia(m, {}), 3000);
          if (mediaBuf && (mediaBuf as any).length > 0) {
            mediaRef = bufferToDataUrl(mediaBuf) || undefined;
          }
        } catch {}
      }

      messagesToSync.push({
        telegramMessageId: String(m.id),
        direction: m.out ? 'out' : 'in',
        senderType: m.out ? 'agent' : 'contact',
        senderId: m.senderId ? String(m.senderId) : undefined,
        text: m.message || (mediaRef ? '' : m.media ? '[Photo]' : ''),
        mediaRef,
        sentAt: new Date(m.date * 1000).toISOString(),
      });
    }

    if (messagesToSync.length > 0) {
      await api.syncMessages({
        telegramAccountId,
        chatExternalId: externalChatId,
        contact: {},
        messages: messagesToSync,
      });
      return true;
    }
  } catch (err) {
    console.warn('[telegramSync] syncFullChatHistory notice:', err);
  }
  return false;
}

