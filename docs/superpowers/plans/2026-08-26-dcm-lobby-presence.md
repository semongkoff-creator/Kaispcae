# Kaitech Lobby Limit + DCM Presence Wording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily limit the Kaitech-org Lobby to only the `kaitech` and `dcm` rooms, and make the existing Member panel show online presence as "Online · {room name}" for every room instead of a bare room name.

**Architecture:** Two independent, single-file changes. Server: `GET /rooms` gains a Kaitech-only hardcoded slug allowlist, applied after the existing DCM-restricted-account branch and before the existing generic org-scoped branch. Client: `MemberListPanel.tsx`'s online-row subtext gains a literal `"Online · "` prefix.

**Tech Stack:** Node/Express (server), React/TypeScript (client), Prisma — no schema changes.

## Global Constraints

- The Lobby limit applies ONLY when `organizationId === DEFAULT_ORG_ID` (Kaitech) — every other organization's `GET /rooms` response must be byte-for-byte unaffected.
- The limit is a Lobby-LIST-only change — `GET /rooms/:slug` and socket `JOIN_ROOM` must NOT be touched. Direct-link/slug entry to any of the ~188 other rooms keeps working exactly as today.
- Implemented as a hardcoded 2-slug array (`['kaitech', 'dcm']`), not a new database field or migration — explicitly reversible later by deleting/editing that one array.
- The existing DCM-restricted-account branch (`req.restrictedToRoomId` truthy) in `GET /rooms` is checked BEFORE the new Kaitech-org branch and must remain completely unchanged in behavior — a DCM-restricted account's Lobby still shows exactly their one allowed room, never the 2-slug Kaitech list.
- The Member panel wording change (`"Online · {roomName}"`) applies uniformly to every room's online row, not a DCM-specific special case. The separate "Kamu di room: …" header line (`MemberListPanel.tsx:62`) must NOT be changed.
- No test framework exists in this repo. `npm run typecheck --workspace=server` / `npm run typecheck --workspace=client` are the verification gates — each takes 3-5+ minutes on this machine. Tell every implementer this explicitly.

---

### Task 1: Server — Kaitech-only Lobby slug allowlist

**Files:**
- Modify: `server/src/routes/rooms.ts:1-16` (imports), `server/src/routes/rooms.ts:72-123` (`GET /rooms` handler)

**Interfaces:**
- Consumes: `DEFAULT_ORG_ID` (`server/src/lib/defaultOrg.ts`, exported constant `'org_kaitech_default'`), `req.organizationId`/`req.restrictedToRoomId` (`AuthRequest`, `server/src/middleware/auth.ts` — both already resolved before this handler runs, no changes needed there).
- Produces: nothing consumed elsewhere in this plan — Task 2 is fully independent (different file, no shared code).

- [ ] **Step 1: Add the `DEFAULT_ORG_ID` import**

`server/src/routes/rooms.ts` currently has no import of `DEFAULT_ORG_ID` (confirmed by reading the file's current imports, lines 1-24). Every other file in `server/src/routes/` that needs it imports it the same way (e.g. `server/src/routes/auth.ts:12`: `import { DEFAULT_ORG_ID } from '../lib/defaultOrg';`). Add the same import line to `rooms.ts`, directly after the existing `import { authenticateToken, AuthRequest } from '../middleware/auth';` line (currently line 7):

```ts
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { DEFAULT_ORG_ID } from '../lib/defaultOrg';
```

- [ ] **Step 2: Add the Kaitech-only allowlist filter to `GET /rooms`**

The current handler (`server/src/routes/rooms.ts:72-123`) is:

```ts
rooms.get('/rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    // DCM restricted accounts — undefined means authenticateToken's own
    // lookup threw and this account's restriction status was never actually
    // resolved (see AuthRequest's restrictedToRoomId comment); that must NOT
    // be treated the same as null (confirmed unrestricted). In practice the
    // organizationId guard just above already rejects on this same
    // underlying failure (both fields come from one query in
    // authenticateToken), but this doesn't depend on that coupling holding
    // forever — an empty list here is the same shape the client already
    // handles for "your one allowed room was deleted" (see comment below).
    if (req.restrictedToRoomId === undefined) {
      return res.json({ rooms: [] });
    }
    const prisma = getPrisma();
    // DCM restricted accounts — a restricted account's Lobby shows exactly
    // one room (or zero, if it's since been deleted), never the org's full
    // public list.
    const roomList = await prisma.room.findMany({
      where: req.restrictedToRoomId
        ? { id: req.restrictedToRoomId, organizationId: req.organizationId }
        : { isPublic: true, organizationId: req.organizationId },
      include: {
        owner: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Higher cap so the Lobby's client-side search/sort covers effectively
      // all active rooms, not just the 50 most recent. Still bounded so a
      // runaway room count can't return an unbounded payload.
      take: 300,
    });
```

Change the `where` clause (only) to:

```ts
rooms.get('/rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    // DCM restricted accounts — undefined means authenticateToken's own
    // lookup threw and this account's restriction status was never actually
    // resolved (see AuthRequest's restrictedToRoomId comment); that must NOT
    // be treated the same as null (confirmed unrestricted). In practice the
    // organizationId guard just above already rejects on this same
    // underlying failure (both fields come from one query in
    // authenticateToken), but this doesn't depend on that coupling holding
    // forever — an empty list here is the same shape the client already
    // handles for "your one allowed room was deleted" (see comment below).
    if (req.restrictedToRoomId === undefined) {
      return res.json({ rooms: [] });
    }
    const prisma = getPrisma();
    // Temporary Lobby declutter during the DCM rollout, Kaitech org only —
    // every other room still exists and is still directly enterable by slug/
    // link (GET /rooms/:slug and JOIN_ROOM are untouched); this only narrows
    // what shows up in the Lobby LIST. Revert by deleting this constant and
    // the ternary branch below that references it, falling back to the
    // plain isPublic query for every org including Kaitech.
    const ACTIVE_KAITECH_ROOM_SLUGS = ['kaitech', 'dcm'];
    // DCM restricted accounts — a restricted account's Lobby shows exactly
    // one room (or zero, if it's since been deleted), never the org's full
    // public list.
    const roomList = await prisma.room.findMany({
      where: req.restrictedToRoomId
        ? { id: req.restrictedToRoomId, organizationId: req.organizationId }
        : req.organizationId === DEFAULT_ORG_ID
          ? { isPublic: true, organizationId: req.organizationId, slug: { in: ACTIVE_KAITECH_ROOM_SLUGS } }
          : { isPublic: true, organizationId: req.organizationId },
      include: {
        owner: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Higher cap so the Lobby's client-side search/sort covers effectively
      // all active rooms, not just the 50 most recent. Still bounded so a
      // runaway room count can't return an unbounded payload.
      take: 300,
    });
```

Nothing else in the handler changes — the response-shaping `.map(...)` block, the `catch`, and everything else stays exactly as-is.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`

This is slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/rooms.ts
git commit -m "feat: temporarily limit Kaitech Lobby to kaitech + dcm rooms"
```

---

### Task 2: Client — Member panel "Online · {room}" presence wording

**Files:**
- Modify: `client/src/components/ui/MemberListPanel.tsx:97-101`

**Interfaces:**
- Consumes: nothing from Task 1 — this task touches presentation only, no new data is needed (`r.presence.roomName`/`r.presence.zoneName` are already available in this component today).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Change the online-row presence subtext**

The current code (`client/src/components/ui/MemberListPanel.tsx:97-101`) is:

```tsx
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {online
                      ? `${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}`
                      : 'Offline'}
                  </p>
```

Change it to:

```tsx
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {online
                      ? `Online · ${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}`
                      : 'Offline'}
                  </p>
```

This is the only change in this file. Do NOT touch the "Kamu di room: …" line (`MemberListPanel.tsx:62`, `myRoomName`) — that line already states "you're in room X" explicitly and does not get an "Online" prefix.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=client`

This is slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ui/MemberListPanel.tsx
git commit -m "feat: show \"Online · {room}\" in the Member panel presence row"
```

---

## Manual Testing After Deploy

1. As a normal Kaitech account, confirm the Lobby shows ONLY `kaitech` and `dcm` — no other room.
2. Confirm a normal Kaitech account can still navigate directly to a URL for one of the other (now-hidden-from-Lobby) rooms and enter it normally — the change only affects the Lobby list, not entry.
3. As a non-Kaitech-org account (if one is available to test with), confirm their Lobby is completely unaffected — full room list as before.
4. Open the Member panel and confirm an online DCM-restricted account shows "Online · DCM", and confirm a normal online account in another room shows "Online · {that room's name}" (not just the DCM case).
5. Confirm a currently-offline member still shows "Offline" (unchanged).
