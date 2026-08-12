import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage, MusicTrack, MusicSessionState, MUSIC_BOT_SENDER_ID, MUSIC_BOT_NAME, MUSIC_PLAY_COOLDOWN_MS } from '@kaispace/shared';
import { getSocketIdsInZone } from './zoneHandler';
import { searchYoutube, getVideoDurationSec } from '../lib/youtubeService';

// Music Bot — !play/!skip/!pause/!resume/!queue/!stop chat commands, one
// independent MusicSession PER ZONE (see chatHandler.ts, which routes zone
// chat text starting with one of these prefixes here instead of broadcasting
// it as an ordinary message). In-memory only, same convention as
// zoneHandler.ts's socketZone map and roomHandler.ts's soundboardCooldown —
// this is cosmetic "listen together" state, not something that needs to
// survive a server restart or be queryable outside the live socket layer.

let messageId = 0;
const PREFIXES = ['!play ', '!skip', '!pause', '!resume', '!queue', '!stop'];

export function isMusicCommand(text: string): boolean {
  const t = text.trim();
  return t === '!play' || PREFIXES.some((p) => t === p || t.startsWith(p));
}

interface CurrentTrack {
  track: MusicTrack;
  startedAt: number;
  pausedAt: number | null;
  durationSec: number;
}

interface Session {
  current: CurrentTrack | null;
  queue: MusicTrack[];
  advanceTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>(); // key: `${room}::${zoneId}`
const playCooldown = new Map<string, number>(); // socket.id -> last !play timestamp (ms)

function sessionKey(room: string, zoneId: string): string {
  return `${room}::${zoneId}`;
}

function getSession(room: string, zoneId: string): Session {
  const key = sessionKey(room, zoneId);
  let s = sessions.get(key);
  if (!s) {
    s = { current: null, queue: [], advanceTimer: null };
    sessions.set(key, s);
  }
  return s;
}

function clearAdvanceTimer(s: Session): void {
  if (s.advanceTimer) {
    clearTimeout(s.advanceTimer);
    s.advanceTimer = null;
  }
}

function sendBotMessage(io: Server, room: string, zoneId: string, text: string, thumbnail?: string): void {
  const msg: ChatMessage = {
    id: `bot-${Date.now()}-${++messageId}`,
    senderId: MUSIC_BOT_SENDER_ID,
    senderName: MUSIC_BOT_NAME,
    senderColor: '#a855f7',
    text,
    timestamp: Date.now(),
    zoneId,
    isBot: true,
    botThumbnailUrl: thumbnail,
  };
  for (const socketId of getSocketIdsInZone(room, zoneId)) {
    io.to(socketId).emit(SocketEvents.CHAT_BROADCAST, msg);
  }
}

function toPayload(s: Session, zoneId: string): MusicSessionState {
  return {
    zoneId,
    current: s.current
      ? { track: s.current.track, startedAt: s.current.startedAt, pausedAt: s.current.pausedAt, durationSec: s.current.durationSec }
      : null,
    queue: s.queue,
  };
}

function broadcastState(io: Server, room: string, zoneId: string): void {
  const s = getSession(room, zoneId);
  const payload = toPayload(s, zoneId);
  for (const socketId of getSocketIdsInZone(room, zoneId)) {
    io.to(socketId).emit(SocketEvents.MUSIC_STATE, payload);
  }
}

// Pushes the zone's current Music Bot state (if any) to a single socket —
// called from zoneHandler.ts the moment ZONE_ENTER is handled, so a client
// walking into a zone where a track is already playing gets it immediately
// (headless MusicPlayerWidget picks it up and starts playing on its own, no
// click/popup needed) instead of waiting for the next !play/!skip/etc to
// happen to trigger a broadcast.
export function sendMusicStateToSocket(socket: Socket, room: string, zoneId: string): void {
  const s = getSession(room, zoneId);
  socket.emit(SocketEvents.MUSIC_STATE, toPayload(s, zoneId));
}

// A track with no resolvable duration (lookup failed/unconfigured) still
// needs to end eventually — 4 minutes is a reasonable median song length so
// the queue doesn't stall forever on one unresolved lookup.
const FALLBACK_DURATION_SEC = 240;

function scheduleAdvance(io: Server, room: string, zoneId: string): void {
  const s = getSession(room, zoneId);
  clearAdvanceTimer(s);
  if (!s.current || s.current.pausedAt !== null) return;
  const elapsedMs = Date.now() - s.current.startedAt;
  const remainingMs = Math.max(0, s.current.durationSec * 1000 - elapsedMs);
  // +500ms slack so the timer never fires a hair before the track actually
  // finishes client-side.
  s.advanceTimer = setTimeout(() => advance(io, room, zoneId), remainingMs + 500);
}

async function playNow(io: Server, room: string, zoneId: string, track: MusicTrack): Promise<void> {
  const s = getSession(room, zoneId);
  const durationSec = (await getVideoDurationSec(track.videoId)) ?? FALLBACK_DURATION_SEC;
  s.current = { track, startedAt: Date.now(), pausedAt: null, durationSec };
  scheduleAdvance(io, room, zoneId);
  broadcastState(io, room, zoneId);
  sendBotMessage(io, room, zoneId, `🎵 Now playing: ${track.title} (diminta oleh ${track.requestedBy})`, track.thumbnail);
}

function advance(io: Server, room: string, zoneId: string): void {
  const s = getSession(room, zoneId);
  const next = s.queue.shift();
  clearAdvanceTimer(s);
  if (!next) {
    s.current = null;
    broadcastState(io, room, zoneId);
    sendBotMessage(io, room, zoneId, 'Antrean habis, Music Bot berhenti.');
    return;
  }
  void playNow(io, room, zoneId, next);
}

export async function handleMusicCommand(
  io: Server,
  room: string,
  zoneId: string,
  senderSocketId: string,
  senderName: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  const s = getSession(room, zoneId);

  if (trimmed === '!skip') {
    if (!s.current) { sendBotMessage(io, room, zoneId, 'Tidak ada lagu yang sedang main.'); return; }
    advance(io, room, zoneId);
    return;
  }

  if (trimmed === '!pause') {
    if (!s.current) { sendBotMessage(io, room, zoneId, 'Tidak ada lagu yang sedang main.'); return; }
    if (s.current.pausedAt !== null) { sendBotMessage(io, room, zoneId, 'Lagu sudah dijeda.'); return; }
    s.current.pausedAt = Date.now();
    clearAdvanceTimer(s);
    broadcastState(io, room, zoneId);
    return;
  }

  if (trimmed === '!resume') {
    if (!s.current || s.current.pausedAt === null) { sendBotMessage(io, room, zoneId, 'Tidak ada lagu yang dijeda.'); return; }
    // Shift startedAt forward by however long the pause lasted, so elapsed
    // playback (now - startedAt) is unchanged across the pause — resuming
    // continues from where it left off instead of jumping ahead or restarting.
    const pausedForMs = Date.now() - s.current.pausedAt;
    s.current.startedAt += pausedForMs;
    s.current.pausedAt = null;
    scheduleAdvance(io, room, zoneId);
    broadcastState(io, room, zoneId);
    return;
  }

  if (trimmed === '!queue') {
    if (s.queue.length === 0) {
      sendBotMessage(io, room, zoneId, 'Antrean kosong.');
    } else {
      const list = s.queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      sendBotMessage(io, room, zoneId, `Antrean saat ini:\n${list}`);
    }
    return;
  }

  if (trimmed === '!stop') {
    clearAdvanceTimer(s);
    s.current = null;
    s.queue = [];
    broadcastState(io, room, zoneId);
    sendBotMessage(io, room, zoneId, 'Music Bot dihentikan, antrean dikosongkan.');
    return;
  }

  if (trimmed === '!play' || trimmed.startsWith('!play ')) {
    const query = trimmed.slice('!play'.length).trim();
    if (!query) {
      sendBotMessage(io, room, zoneId, 'Ketik judul lagu setelah !play, contoh: !play wonderwall');
      return;
    }

    const now = Date.now();
    const lastPlay = playCooldown.get(senderSocketId) ?? 0;
    const waitedMs = now - lastPlay;
    if (waitedMs < MUSIC_PLAY_COOLDOWN_MS) {
      const waitSec = Math.ceil((MUSIC_PLAY_COOLDOWN_MS - waitedMs) / 1000);
      sendBotMessage(io, room, zoneId, `Tunggu ${waitSec} detik lagi sebelum !play berikutnya.`);
      return;
    }
    playCooldown.set(senderSocketId, now);

    const result = await searchYoutube(query);
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        sendBotMessage(io, room, zoneId, 'Music Bot belum dikonfigurasi (API key belum diisi admin).');
      } else if (result.reason === 'quota_exceeded') {
        sendBotMessage(io, room, zoneId, 'Music Bot lagi kehabisan kuota pencarian hari ini, coba lagi besok atau pakai upload manual (BGM lewat Room Editor).');
      } else if (result.reason === 'no_results') {
        sendBotMessage(io, room, zoneId, 'Lagu tidak ditemukan, coba judul lain.');
      } else {
        sendBotMessage(io, room, zoneId, 'Music Bot gagal mencari lagu, coba lagi.');
      }
      return;
    }

    const track: MusicTrack = { videoId: result.videoId, title: result.title, thumbnail: result.thumbnail, requestedBy: senderName };

    if (!s.current) {
      await playNow(io, room, zoneId, track);
    } else {
      s.queue.push(track);
      broadcastState(io, room, zoneId);
      sendBotMessage(io, room, zoneId, `➕ Ditambahkan ke antrean (posisi #${s.queue.length}): ${track.title}`, track.thumbnail);
    }
    return;
  }
}
