import { useCallback, useEffect, useRef, useState } from 'react';

export interface PendingAttachment {
  id: string;
  file: File;
  // Local blob: preview, image files only — free, no network involved,
  // same mechanism useChannelChat.ts's sendFileMessage already uses for
  // its own optimistic message bubble. null for non-image files (they get
  // a name/type/size card instead, see AttachmentTray.tsx).
  previewUrl: string | null;
}

// Local staging area for chat attachments between "paste/attach" and
// "Kirim" — nothing here uploads or sends anything; that only happens once
// the caller drains `items` on send (see ChatPanel.tsx/MessengerApp.tsx's
// handleSend). Lets a user paste/attach several files, review them, remove
// one, then send everything together with the typed text.
export function usePendingAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  // Mirrors `items` for use inside clear()/the unmount cleanup below, so
  // those don't need `items` in their own dependency array just to read
  // the latest value.
  const itemsRef = useRef<PendingAttachment[]>(items);
  itemsRef.current = items;

  const add = useCallback((file: File) => {
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    setItems((prev) => [...prev, { id: crypto.randomUUID(), file, previewUrl }]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((i) => i.id === id);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    itemsRef.current.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
    setItems([]);
  }, []);

  // Revoke any still-pending previews if the panel closes / target switches
  // away without the user ever hitting Kirim — otherwise those blob: URLs
  // leak for the rest of the session.
  useEffect(() => () => {
    itemsRef.current.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
  }, []);

  return { items, add, remove, clear };
}
