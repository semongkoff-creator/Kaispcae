import { getTenantToken, LARK_OPENAPI_BASE as LARK } from './larkToken';

// A5 — Lark VC (Video Conference). Reserve a meeting with auto-record, then
// (async) fetch the recording once Lark finishes processing it. Response shapes
// are parsed defensively + logged, since exact nesting can vary by version.
// Needs scopes vc:reserve (reserve) and vc:record:readonly (recording).

export interface ReservedMeeting {
  reserveId: string;
  meetingNo: string;
  url: string;
}

// Reserve a meeting owned by ownerOpenId. auto_record on. Returns null on any
// failure (caller keeps the app working regardless).
export async function reserveMeeting(ownerOpenId: string, topic: string): Promise<ReservedMeeting | null> {
  const tenant = await getTenantToken();
  if (!tenant) return null;
  // Reservation validity window — 4h is plenty for a meeting; it's just when
  // the reservation (not the meeting) expires if never started.
  const endTime = String(Math.floor(Date.now() / 1000) + 4 * 3600);
  try {
    const res = await fetch(`${LARK}/vc/v1/reserves/apply?user_id_type=open_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant}` },
      body: JSON.stringify({
        end_time: endTime,
        owner_id: ownerOpenId,
        meeting_settings: { topic, auto_record: true },
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) { console.error('[larkVc] reserve failed:', j?.code, j?.msg); return null; }
    const r = j?.data?.reserve ?? j?.data ?? {};
    if (!r.id || !r.url) { console.error('[larkVc] reserve missing fields:', JSON.stringify(j?.data ?? {}).slice(0, 300)); return null; }
    return { reserveId: r.id, meetingNo: r.meeting_no ?? '', url: r.url };
  } catch (e) {
    console.error('[larkVc] reserve error:', e);
    return null;
  }
}

// The real meeting_id (needed for recording) only exists once the meeting has
// actually started. Returns null if not started yet.
export async function getActiveMeetingId(reserveId: string): Promise<string | null> {
  const tenant = await getTenantToken();
  if (!tenant) return null;
  try {
    const res = await fetch(`${LARK}/vc/v1/reserves/${reserveId}/get_active_meeting`, {
      headers: { Authorization: `Bearer ${tenant}` },
    });
    const j: any = await res.json();
    if (j?.code !== 0) return null; // not started yet is a normal, non-error state here
    return j?.data?.meeting?.id ?? null;
  } catch (e) {
    console.warn('[larkVc] get_active_meeting error:', e);
    return null;
  }
}

// Recording URL for a started meeting. Returns null until Lark has finished
// processing the recording (async) — OR permanently null if the tenant's Lark
// plan doesn't include VC cloud recording. Caller treats null as "not ready".
export async function getRecordingUrl(meetingId: string): Promise<string | null> {
  const tenant = await getTenantToken();
  if (!tenant) return null;
  try {
    const res = await fetch(`${LARK}/vc/v1/meetings/${meetingId}/recording`, {
      headers: { Authorization: `Bearer ${tenant}` },
    });
    const j: any = await res.json();
    if (j?.code !== 0) return null; // still processing / not available
    return j?.data?.recording?.url ?? null;
  } catch (e) {
    console.warn('[larkVc] recording error:', e);
    return null;
  }
}
