import { useEffect, useState } from 'react';
import { api } from '@/services/api';

// Session-wide cache shared across every chat render: a userId is looked up at
// most once (value `null` = looked up, has no photo). Chat passes the sender
// ids currently in view and any not-yet-known ones are fetched in ONE batch
// call — never per message, so scrollback can't turn into an N+1.
const cache = new Map<string, string | null>();

export function useProfilePhotos(userIds: string[]): Map<string, string> {
  const [, tick] = useState(0);
  const key = userIds.join(',');

  useEffect(() => {
    const missing = userIds.filter((id) => id && !cache.has(id));
    if (missing.length === 0) return;
    // Reserve them (null) so a re-render mid-flight doesn't refetch the same ids.
    missing.forEach((id) => cache.set(id, null));
    let alive = true;
    api.getProfilePhotos(missing)
      .then((r) => {
        r.photos.forEach((p) => cache.set(p.id, p.photo));
        if (alive) tick((n) => n + 1); // re-render so the new photos show
      })
      .catch(() => { /* leave reserved as null → falls back to initials */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out = new Map<string, string>();
  for (const id of userIds) {
    const v = cache.get(id);
    if (v) out.set(id, v);
  }
  return out;
}
