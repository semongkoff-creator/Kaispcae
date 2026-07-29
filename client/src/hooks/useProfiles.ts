import { useEffect, useState } from 'react';
import { api } from '@/services/api';

export interface Profile {
  // The user's CURRENT display name (source of truth = the users table, joined
  // live server-side). Chat renders this rather than the senderName snapshot
  // baked into a message when it was received — see Bug 8.
  name: string;
  // null once looked up and the user has no photo → chat falls back to initials.
  photo: string | null;
}

// Session-wide cache shared across every chat render: a userId is looked up at
// most once. Chat passes the sender ids currently in view and any not-yet-known
// ones are fetched in ONE batch call — never per message, so scrollback can't
// turn into an N+1. Because identity is resolved by id at render time (not read
// from each message's stored senderName), old messages automatically show the
// sender's LATEST name/photo the next time chat is opened.
const cache = new Map<string, Profile>();

export function useProfiles(userIds: string[]): Map<string, Profile> {
  const [, tick] = useState(0);
  const key = userIds.join(',');

  useEffect(() => {
    const missing = userIds.filter((id) => id && !cache.has(id));
    if (missing.length === 0) return;
    // Reserve them so a re-render mid-flight doesn't refetch the same ids. The
    // placeholder name is empty so callers keep falling back to the message's
    // own senderName until the real value lands.
    missing.forEach((id) => cache.set(id, { name: '', photo: null }));
    let alive = true;
    api.getProfiles(missing)
      .then((r) => {
        r.profiles.forEach((p) => cache.set(p.id, { name: p.name, photo: p.photo }));
        if (alive) tick((n) => n + 1); // re-render so the resolved identities show
      })
      .catch(() => { /* leave reserved placeholders → fall back to snapshot name / initials */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out = new Map<string, Profile>();
  for (const id of userIds) {
    const v = cache.get(id);
    if (v) out.set(id, v);
  }
  return out;
}
