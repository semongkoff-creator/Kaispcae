import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';

// Bagian 4 — Lark IM (messenger) API calls for the two-way chat sync. All
// functions are defensive/null-graceful: a Lark outage or a missing scope must
// never break MeetKai's own chat (outbound is fire-and-forget, see
// channelChatHandler), so every path logs and returns null/[] rather than
// throwing.

export interface LarkChatSummary {
  chatId: string;
  name: string;
}

// Send a plain-text message to a group chat AS THE BOT. Returns the Lark
// message_id (needed for the anti-echo ledger) or null on any failure.
// Requires scope im:message / im:message:send_as_bot; the bot must be a member
// of the target chat.
export async function sendGroupText(chatId: string, text: string): Promise<string | null> {
  const token = await getTenantToken();
  if (!token) return null;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] sendGroupText failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.message_id ?? null;
  } catch (e) {
    console.error('[larkIm] sendGroupText error:', e);
    return null;
  }
}

// Bagian 4 upgrade — send a text message to a group AS THE USER, using their
// user_access_token instead of the bot's tenant token. Same endpoint; the
// message appears in Lark under the real user's name/avatar. Requires the
// im:message.send_as_user scope. Returns the Lark message_id or null on any
// failure (caller falls back to the bot). Text is sent verbatim — no [Name]
// prefix, since it's genuinely from that user.
export async function sendAsUser(chatId: string, text: string, userAccessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] sendAsUser failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.message_id ?? null;
  } catch (e) {
    console.error('[larkIm] sendAsUser error:', e);
    return null;
  }
}

// List the group chats the bot belongs to — used to populate the admin mapping
// dropdown so an admin picks from real chats instead of pasting a chat_id.
// Requires scope im:chat:readonly. Paginates through all pages (chat counts are
// small in practice; the page_size cap keeps this bounded regardless).
export async function listBotChats(): Promise<LarkChatSummary[]> {
  const token = await getTenantToken();
  if (!token) return [];
  const out: LarkChatSummary[] = [];
  let pageToken = '';
  try {
    // Hard cap on pages so a pathological account can't spin this forever.
    for (let i = 0; i < 20; i++) {
      const url = new URL(`${LARK_OPENAPI_BASE}/im/v1/chats`);
      url.searchParams.set('page_size', '100');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j: any = await res.json();
      if (j?.code !== 0) {
        console.error('[larkIm] listBotChats failed:', j?.code, j?.msg);
        break;
      }
      for (const item of j?.data?.items ?? []) {
        if (item?.chat_id) out.push({ chatId: item.chat_id, name: item.name || item.chat_id });
      }
      if (!j?.data?.has_more || !j?.data?.page_token) break;
      pageToken = j.data.page_token;
    }
  } catch (e) {
    console.error('[larkIm] listBotChats error:', e);
  }
  return out;
}

// Resolve a Lark open_id → display name, cached in-process. Used only for the
// fallback path where an inbound sender has no matching MeetKai account (so we
// can still prefix their real name). Requires scope contact:user.base:readonly.
// Returns null if unresolved — the caller falls back to a generic label.
const nameCache = new Map<string, { name: string; exp: number }>();
const NAME_TTL_MS = 60 * 60 * 1000; // 1h — names change rarely

export async function getUserName(openId: string): Promise<string | null> {
  if (!openId) return null;
  const hit = nameCache.get(openId);
  if (hit && hit.exp > Date.now()) return hit.name;
  const token = await getTenantToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${LARK_OPENAPI_BASE}/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] getUserName failed:', j?.code, j?.msg);
      return null;
    }
    const name = j?.data?.user?.name ?? null;
    if (name) nameCache.set(openId, { name, exp: Date.now() + NAME_TTL_MS });
    return name;
  } catch (e) {
    console.error('[larkIm] getUserName error:', e);
    return null;
  }
}
