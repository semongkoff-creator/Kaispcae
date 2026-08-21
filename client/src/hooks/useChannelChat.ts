import { useCallback, useEffect, useRef } from 'react';
import { ChannelMessage } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { api } from '@/services/api';

// Bug 6 — plain socket emits have no ack/response, so there's no direct
// signal that a send ever reached the server at all (dropped connection,
// server hiccup, ...). Silence past this long after a send is treated as a
// failure the user can retry, rather than leaving a "Mengirim…" bubble
// stuck forever with no way out. Comfortably above any real round trip
// (normally tens to a few hundred ms) so a merely-slow connection doesn't
// get falsely marked failed out from under a send that's still arriving.
const PENDING_TIMEOUT_MS = 10_000;

interface ChannelChatEmitters {
  emitChannelJoin: (channelId: string) => void;
  emitChannelLeave: (channelId: string) => void;
  emitChannelMessageSend: (channelId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string, clientId?: string) => void;
  emitDmJoin: (conversationId: string) => void;
  emitDmLeave: (conversationId: string) => void;
  emitDmMessageSend: (conversationId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string, clientId?: string) => void;
  emitChannelTyping: (channelId: string) => void;
  emitDmTyping: (conversationId: string) => void;
  emitDeleteMessage: (messageId: string) => void;
  emitEditMessage: (messageId: string, text: string) => void;
  emitPinMessage: (messageId: string, pinned: boolean) => void;
  emitMarkRead: (target: { type: 'channel' | 'dm'; id: string }) => void;
}

function targetKey(target: { type: 'channel' | 'dm'; id: string }): string {
  return `${target.type}:${target.id}`;
}

// Centralizes persisted Channel/DM chat plumbing (see server/src/routes/
// chat.ts) so ChatPanel.tsx stays a presentational component — loads the
// room's channel/DM lists once, joins/leaves the one socket.io room for
// whichever target is currently open, and lazily fetches each target's
// history the first time it's opened (messagesByTarget acts as a cache
// keyed by "channel:<id>"/"dm:<id>", see gameStore.ts's doc comment).
// specs/2026-08-21-room-entry-name-prompt-design.md — final-review fix:
// localAccountName is the REAL account name (currentUser.name from
// App.tsx's Game component), used ONLY for the optimistic pre-confirmation
// echo's senderName below — chat must never show the room-entry nametag.
export function useChannelChat(roomSlug: string, emitters: ChannelChatEmitters, localAccountName: string) {
  const channels = useGameStore((s) => s.channels);
  const setChannels = useGameStore((s) => s.setChannels);
  const dmConversations = useGameStore((s) => s.dmConversations);
  const setDmConversations = useGameStore((s) => s.setDmConversations);
  const activeChatTarget = useGameStore((s) => s.activeChatTarget);
  const setActiveChatTarget = useGameStore((s) => s.setActiveChatTarget);
  const chatPanelOpen = useGameStore((s) => s.chatPanelOpen);
  const setChatPanelOpen = useGameStore((s) => s.setChatPanelOpen);
  const messagesByTarget = useGameStore((s) => s.messagesByTarget);
  const setTargetMessages = useGameStore((s) => s.setTargetMessages);
  const prependTargetMessages = useGameStore((s) => s.prependTargetMessages);
  const clearUnread = useGameStore((s) => s.clearUnread);
  // A server redeploy (or any network blip) disconnects+reconnects the
  // socket. socket.io rooms are per-connection — the new connection isn't
  // in `channel:<id>`/`dm:<id>` until CHANNEL_JOIN/DM_JOIN is re-emitted,
  // and nothing did that automatically before this: the join effect below
  // only re-ran when activeChatTarget itself CHANGED. Silently missing your
  // own room membership doesn't show up as an error — the send still
  // persists+broadcasts to everyone else — only YOUR
  // OWN confirmation (CHANNEL_MESSAGE_NEW) never arrives, so the optimistic
  // bubble just times out and shows "Gagal terkirim" for a message that
  // actually went through. isConnected here as a join-effect dependency
  // makes a reconnect re-run it exactly like an activeChatTarget switch
  // does.
  const isConnected = useGameStore((s) => s.isConnected);

  const prevTargetRef = useRef<{ type: 'channel' | 'dm'; id: string } | null>(null);

  // Load the room's channel + DM lists once, defaulting to the "general"
  // channel if nothing is active yet.
  useEffect(() => {
    let cancelled = false;
    api
      .getChannels(roomSlug)
      .then((res) => {
        if (cancelled) return;
        setChannels(res.channels);
        if (!useGameStore.getState().activeChatTarget) {
          const general = res.channels.find((c) => c.isDefault) ?? res.channels[0];
          if (general) setActiveChatTarget({ type: 'channel', id: general.id });
        }
      })
      .catch((e) => console.error('[chat] failed to load channels:', e));

    api
      .getDMs(roomSlug)
      .then((res) => {
        if (!cancelled) setDmConversations(res.conversations);
      })
      .catch((e) => console.error('[chat] failed to load DMs:', e));

    return () => {
      cancelled = true;
    };
  }, [roomSlug]);

  // Join the active target's socket room and lazily fetch its history;
  // leave whichever target was previously open. Only the currently-open tab
  // needs live updates, mirroring zoneHandler.ts's enter/exit tracking. Also
  // re-runs on reconnect (isConnected — see its own comment above), which
  // re-emits the SAME join for an unchanged target — a harmless leave+join
  // pair on the new connection, not a real target switch.
  useEffect(() => {
    if (!isConnected) return;
    const prev = prevTargetRef.current;
    if (prev) {
      if (prev.type === 'channel') emitters.emitChannelLeave(prev.id);
      else emitters.emitDmLeave(prev.id);
    }
    prevTargetRef.current = activeChatTarget;
    if (!activeChatTarget) return;

    if (activeChatTarget.type === 'channel') emitters.emitChannelJoin(activeChatTarget.id);
    else emitters.emitDmJoin(activeChatTarget.id);

    const key = targetKey(activeChatTarget);
    if (!useGameStore.getState().messagesByTarget[key]) {
      const fetcher =
        activeChatTarget.type === 'channel'
          ? api.getChannelMessages(roomSlug, activeChatTarget.id)
          : api.getDMMessages(activeChatTarget.id);
      fetcher.then((res) => setTargetMessages(key, res.messages)).catch((e) => console.error('[chat] failed to load messages:', e));
    }
  }, [activeChatTarget?.type, activeChatTarget?.id, isConnected]);

  // Clear the unread badge for whatever target is currently on screen — while
  // the panel is open and showing it, the user is reading it live, so any
  // count for it should stay at zero (including messages arriving as they
  // watch). Runs on open, on target switch, and on each new active message.
  // Also tells the server "I've read up to now" (CHAT_MARK_READ) at the same
  // moments, for the same reason — this IS the moment the user has actually
  // seen whatever's currently on screen.
  useEffect(() => {
    if (!chatPanelOpen || !activeChatTarget) return;
    clearUnread(targetKey(activeChatTarget));
    emitters.emitMarkRead(activeChatTarget);
  }, [chatPanelOpen, activeChatTarget?.type, activeChatTarget?.id, messagesByTarget]);

  // Leave whatever's open when the whole room/component unmounts.
  useEffect(() => {
    return () => {
      const target = prevTargetRef.current;
      if (!target) return;
      if (target.type === 'channel') emitters.emitChannelLeave(target.id);
      else emitters.emitDmLeave(target.id);
    };
  }, []);

  const activeMessages = activeChatTarget ? messagesByTarget[targetKey(activeChatTarget)] ?? [] : [];

  // Bug 6 — arms the "still pending after N seconds" failure fallback for one
  // send. Shared by the first attempt and every retry, since both need the
  // exact same "nothing arrived in time" check.
  const armPendingTimeout = useCallback((key: string, clientId: string) => {
    setTimeout(() => {
      const list = useGameStore.getState().messagesByTarget[key] ?? [];
      const stillPending = list.some((m) => m.id === clientId && m.status === 'pending');
      if (stillPending) useGameStore.getState().markMessageFailed(key, clientId);
    }, PENDING_TIMEOUT_MS);
  }, []);

  const sendMessage = useCallback(
    (text: string, parentId?: string, attachment?: { url: string; fileName: string }) => {
      if (!activeChatTarget) return;
      // One id per user-intended send. The server stores it and treats a
      // repeat of the same id as the same message rather than a second one
      // (see ChatMessage.clientId), so a resend can never double-post. It has
      // to be generated HERE, once per send — regenerating it on a retry
      // would defeat the entire purpose.
      const clientId = crypto.randomUUID();

      // Bug 6 — show the bubble NOW, before the socket emit even goes out:
      // that's the whole fix for "chat feels slow" — the sender was always
      // waiting for a full server round trip (persist + broadcast back) just
      // to see their OWN message appear. Thread replies are intentionally
      // skipped: they live in repliesByParent (see appendParentReply in
      // useSocket.ts), a separate store slice this optimistic path doesn't
      // reconcile against yet — inserting one here would show a duplicate
      // that never gets cleaned up.
      if (!parentId) {
        const state = useGameStore.getState();
        const key = targetKey(activeChatTarget);
        const optimistic: ChannelMessage = {
          id: clientId,
          clientId,
          channelId: activeChatTarget.type === 'channel' ? activeChatTarget.id : undefined,
          conversationId: activeChatTarget.type === 'dm' ? activeChatTarget.id : undefined,
          senderId: state.localUserId,
          senderName: localAccountName,
          text,
          createdAt: Date.now(),
          attachmentUrl: attachment?.url,
          attachmentName: attachment?.fileName,
          status: 'pending',
        };
        state.addPendingMessage(key, optimistic);
        armPendingTimeout(key, clientId);
      }

      if (activeChatTarget.type === 'channel') emitters.emitChannelMessageSend(activeChatTarget.id, text, parentId, attachment?.url, attachment?.fileName, clientId);
      else emitters.emitDmMessageSend(activeChatTarget.id, text, parentId, attachment?.url, attachment?.fileName, clientId);
    },
    [activeChatTarget, emitters, armPendingTimeout]
  );

  // Bug 6 — the OTHER half of the delay: attaching a file used to await the
  // ENTIRE upload before anything showed up, then wait the full send round
  // trip on top of that. Now the bubble appears the instant a file is picked
  // (image/video get a local blob: preview — literally free, no network
  // involved), the upload runs in the background, and the real send only
  // fires once it resolves — same clientId throughout, so the eventual
  // server confirmation reconciles this exact bubble instead of adding a new
  // one (see appendTargetMessage's blob: revoke, which waits for that swap).
  const pendingFilesRef = useRef(new Map<string, File>());

  const sendFileMessage = useCallback(
    async (file: File) => {
      if (!activeChatTarget) return;
      const clientId = crypto.randomUUID();
      const key = targetKey(activeChatTarget);
      const previewUrl = URL.createObjectURL(file);
      pendingFilesRef.current.set(clientId, file);

      const state = useGameStore.getState();
      state.addPendingMessage(key, {
        id: clientId,
        clientId,
        channelId: activeChatTarget.type === 'channel' ? activeChatTarget.id : undefined,
        conversationId: activeChatTarget.type === 'dm' ? activeChatTarget.id : undefined,
        senderId: state.localUserId,
        senderName: localAccountName,
        text: '',
        createdAt: Date.now(),
        attachmentUrl: previewUrl,
        attachmentName: file.name,
        status: 'pending',
      });

      try {
        // Potongan C3 — roomSlug scopes the message to this room
        // Drive (see routes/uploads.ts's resolveRoomFolder): without it the
        // upload silently fell back to local disk every time, even with
        // Drive fully configured and working everywhere else.
        const { url, fileName } = await api.uploadMedia(file, roomSlug);
        // The File itself is only ever needed to RETRY the upload step —
        // once it succeeds, every future retry (if the send confirmation
        // itself later times out) only needs to re-emit the already-known
        // real url, not the file again (see retryMessage's non-file branch).
        pendingFilesRef.current.delete(clientId);
        if (activeChatTarget.type === 'channel') emitters.emitChannelMessageSend(activeChatTarget.id, '', undefined, url, fileName, clientId);
        else emitters.emitDmMessageSend(activeChatTarget.id, '', undefined, url, fileName, clientId);
        armPendingTimeout(key, clientId);
      } catch (e) {
        console.error('[chat] file upload failed:', e);
        useGameStore.getState().markMessageFailed(key, clientId);
        // pendingFilesRef keeps the File (retry needs it) and the blob:
        // preview is NOT revoked: the failed bubble keeps showing this exact
        // preview (with a retry affordance) — only a successful
        // reconciliation (appendTargetMessage) revokes it, once the real URL
        // has taken over.
      }
    },
    [activeChatTarget, emitters, armPendingTimeout]
  );

  // Re-attempts a message still sitting in 'failed' status. Reuses the exact
  // same clientId (the server's dedup on it is what makes this safe to call
  // freely — never a duplicate row even if the original actually DID land
  // and only the confirmation was lost) and, for a file send, the original
  // File kept in pendingFilesRef (a fresh upload needs the real File object —
  // there's no way to re-derive one from an already-revoked/broken blob: URL).
  const retryMessage = useCallback(
    async (message: ChannelMessage) => {
      if (!activeChatTarget || !message.clientId || message.status !== 'failed') return;
      const key = targetKey(activeChatTarget);
      const clientId = message.clientId;
      const file = pendingFilesRef.current.get(clientId);

      if (file) {
        useGameStore.getState().markMessagePending(key, clientId);
        try {
          const { url, fileName } = await api.uploadMedia(file, roomSlug);
          pendingFilesRef.current.delete(clientId);
          if (activeChatTarget.type === 'channel') emitters.emitChannelMessageSend(activeChatTarget.id, '', undefined, url, fileName, clientId);
          else emitters.emitDmMessageSend(activeChatTarget.id, '', undefined, url, fileName, clientId);
          armPendingTimeout(key, clientId);
        } catch (e) {
          console.error('[chat] retry upload failed:', e);
          useGameStore.getState().markMessageFailed(key, clientId);
        }
        return;
      }

      useGameStore.getState().markMessagePending(key, clientId);
      if (activeChatTarget.type === 'channel') emitters.emitChannelMessageSend(activeChatTarget.id, message.text, message.parentId, message.attachmentUrl, message.attachmentName, clientId);
      else emitters.emitDmMessageSend(activeChatTarget.id, message.text, message.parentId, message.attachmentUrl, message.attachmentName, clientId);
      armPendingTimeout(key, clientId);
    },
    [activeChatTarget, emitters, armPendingTimeout]
  );

  // Fire a typing ping for the active target, throttled so a burst of
  // keystrokes only sends ~one ping per interval (the server relays each ping
  // and the receiver's indicator lasts a few seconds, so more is wasteful).
  const lastTypingRef = useRef(0);
  const notifyTyping = useCallback(() => {
    if (!activeChatTarget) return;
    const now = Date.now();
    if (now - lastTypingRef.current < 1500) return;
    lastTypingRef.current = now;
    if (activeChatTarget.type === 'channel') emitters.emitChannelTyping(activeChatTarget.id);
    else emitters.emitDmTyping(activeChatTarget.id);
  }, [activeChatTarget, emitters]);

  const deleteMessage = useCallback((messageId: string) => {
    emitters.emitDeleteMessage(messageId);
  }, [emitters]);

  const editMessage = useCallback((messageId: string, text: string) => {
    emitters.emitEditMessage(messageId, text);
  }, [emitters]);

  const pinMessage = useCallback((messageId: string, pinned: boolean) => {
    emitters.emitPinMessage(messageId, pinned);
  }, [emitters]);

  const loadOlder = useCallback(async () => {
    if (!activeChatTarget) return 0;
    const key = targetKey(activeChatTarget);
    const oldest = (useGameStore.getState().messagesByTarget[key] ?? [])[0];
    if (!oldest) return 0;
    const res =
      activeChatTarget.type === 'channel'
        ? await api.getChannelMessages(roomSlug, activeChatTarget.id, oldest.id)
        : await api.getDMMessages(activeChatTarget.id, oldest.id);
    if (res.messages.length > 0) prependTargetMessages(key, res.messages);
    return res.messages.length;
  }, [activeChatTarget, roomSlug]);

  const createChannel = useCallback(
    async (name: string) => {
      const res = await api.createChannel(roomSlug, name);
      const state = useGameStore.getState();
      if (!state.channels.some((c) => c.id === res.channel.id)) {
        state.setChannels([...state.channels, res.channel]);
      }
      setActiveChatTarget({ type: 'channel', id: res.channel.id });
      return res.channel;
    },
    [roomSlug]
  );

  const startDm = useCallback(
    async (otherUserId: string) => {
      const res = await api.startDM(roomSlug, otherUserId);
      const state = useGameStore.getState();
      if (!state.dmConversations.some((c) => c.id === res.conversation.id)) {
        state.setDmConversations([res.conversation, ...state.dmConversations]);
      }
      setActiveChatTarget({ type: 'dm', id: res.conversation.id });
      setChatPanelOpen(true);
      return res.conversation;
    },
    [roomSlug]
  );

  return {
    channels,
    dmConversations,
    activeChatTarget,
    setActiveChatTarget,
    chatPanelOpen,
    setChatPanelOpen,
    activeMessages,
    sendMessage,
    sendFileMessage,
    retryMessage,
    notifyTyping,
    deleteMessage,
    editMessage,
    pinMessage,
    loadOlder,
    createChannel,
    startDm,
  };
}
