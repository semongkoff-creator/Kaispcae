import { useCallback, useEffect, useRef } from 'react';
import { useGameStore } from '@/stores/gameStore';
import { api } from '@/services/api';

interface ChannelChatEmitters {
  emitChannelJoin: (channelId: string) => void;
  emitChannelLeave: (channelId: string) => void;
  emitChannelMessageSend: (channelId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string) => void;
  emitDmJoin: (conversationId: string) => void;
  emitDmLeave: (conversationId: string) => void;
  emitDmMessageSend: (conversationId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string) => void;
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
export function useChannelChat(roomSlug: string, emitters: ChannelChatEmitters) {
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
  // needs live updates, mirroring zoneHandler.ts's enter/exit tracking.
  useEffect(() => {
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
  }, [activeChatTarget?.type, activeChatTarget?.id]);

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

  const sendMessage = useCallback(
    (text: string, parentId?: string, attachment?: { url: string; fileName: string }) => {
      if (!activeChatTarget) return;
      if (activeChatTarget.type === 'channel') emitters.emitChannelMessageSend(activeChatTarget.id, text, parentId, attachment?.url, attachment?.fileName);
      else emitters.emitDmMessageSend(activeChatTarget.id, text, parentId, attachment?.url, attachment?.fileName);
    },
    [activeChatTarget, emitters]
  );

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
    loadOlder,
    createChannel,
    startDm,
  };
}
