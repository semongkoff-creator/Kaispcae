import type { ReactNode } from 'react';

// Potongan C2 — the "@[Name](userId)" token the #general/DM chat input's
// mention autocomplete inserts (see ChatPanel.tsx's insertMention). Parsed
// back out here at render time, shared by every surface that renders
// ChannelMessage text (ChatPanel's own bubbles + thread replies, and
// MessengerApp's full-screen view of the exact same messages) so a mention
// looks and behaves identically no matter which one you're looking at.
const MENTION_PATTERN = '@\\[([^\\]]+)\\]\\(([^)]+)\\)';

export function textMentionsUser(text: string, userId: string): boolean {
  return [...text.matchAll(new RegExp(MENTION_PATTERN, 'g'))].some((m) => m[2] === userId);
}

// Splits message text into plain segments + styled mention spans. Renders
// the mentioned NAME (not the raw token) — the userId in parentheses is
// only ever a render-time lookup key, never shown. Mentions of the current
// viewer get a stronger highlight so being mentioned actually stands out,
// not just reads the same purple as anyone else's name.
export function renderWithMentions(text: string, localUserId: string): ReactNode[] {
  const re = new RegExp(MENTION_PATTERN, 'g');
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const [, name, userId] = match;
    const isMe = userId === localUserId;
    parts.push(
      <span
        key={`mention-${key++}`}
        className={isMe
          ? 'font-semibold text-purple-800 dark:text-purple-100 bg-purple-300/70 dark:bg-purple-600/50 rounded px-1'
          : 'font-medium text-purple-700 dark:text-purple-300 bg-purple-100/80 dark:bg-purple-900/40 rounded px-1'}
      >
        @{name}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
