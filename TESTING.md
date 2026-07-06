# TESTING.md — Manual QA Checklist

Run through this after any significant change (new feature, refactor, dependency
bump) before considering the app ready to demo or deploy. Check off each item as
BERHASIL (pass) / GAGAL (fail, note why) / TIDAK BISA DIUJI (couldn't test, note why).

Setup: `docker compose up -d postgres redis`, then `npm run dev` from the repo
root, open http://localhost:5173 in two different browsers (or one normal + one
incognito window) to simulate two accounts.

## Auth & rooms

- [ ] Register a new account → login → lands in the Lobby
- [ ] Create a new room from the Lobby → successfully enters the room
- [ ] Join a room via its code/slug from a second account → both see each other
- [ ] Delete a room as its owner → **other players currently inside get kicked
      back to the Lobby immediately** (this used to silently do nothing — fixed
      2026-07-05, see git history)
- [ ] Log in with the wrong password 10+ times in a row → rate-limited (429)
      instead of allowed to keep guessing

## Avatar & rendering

- [ ] Avatar renders as a pixel-art sprite (not a plain shape), 4-direction
      walk animation looks distinct per direction
- [ ] Avatar customization (body/hair/outfit/eyes/accessory) saves and survives
      a full page reload
- [ ] Premade character picker (Adam/Alex/etc.) works as an alternative to the
      layered builder
- [ ] Tilemap renders from the real tileset (not solid colors); collision
      against walls/furniture still blocks movement
- [ ] Room Editor: pick a tile from the visual palette and place it on the map

## Multi-user / real-time

- [ ] Two browser tabs, two accounts, in the **same** room: moving one avatar
      is visible to the other in real time
- [ ] Two browser tabs in **different** rooms: actions in room A (movement,
      chat, emotes) must **not** appear in room B (this was a real bug — the
      server used to broadcast these events to every connected client
      regardless of room — fixed 2026-07-05)
- [ ] Two avatars walk within ~3 tiles of each other → audio/video call
      connects automatically
- [ ] Two avatars walk apart → call disconnects automatically, with a short
      debounce (doesn't drop instantly at the edge of range)
- [ ] Private zone: two players inside the same zone can hear/see each other
      regardless of on-screen distance; a player outside the zone does not
      join the call even if pixel-close
- [ ] Screen share button works, shared screen appears for other participants
- [ ] Walking onto a portal/door tile moves the avatar to the target room's
      correct spawn point
- [ ] Text chat and the floating speech bubble above the avatar work
- [ ] Chat "Private" tab appears automatically inside a zone; messages sent
      there only reach others in the same zone (verified server-side via
      automated test — see below)
- [ ] Emote wheel opens, selected emote plays above the avatar

## Admin

- [ ] Room owner grants admin to another player → badge appears for them
- [ ] A non-master-admin trying to revoke someone's admin is rejected
- [ ] A non-owner cannot delete the room, even by guessing/spoofing the
      owner's account id (verified server-side via automated test — this was
      a real privilege-escalation bug, fixed 2026-07-05)

## Resilience / error handling

- [ ] Disconnect networking briefly during an active call → client shows a
      "reconnecting" state and actually attempts to reconnect
- [ ] Deny mic/camera permission on first join → a clear error message is
      shown, not a silent failure
- [ ] All screens (login, lobby, avatar setup, in-room HUD, admin panel, room
      editor) are visually consistent in the white/purple theme

## What's already covered by automated checks

These don't need to be manually re-verified every time — `npm run typecheck`,
and the functional script pattern below, cover them:

- TypeScript compiles clean across all three workspaces (`npm run typecheck`)
- Full production build succeeds (`npm run build`) and the server's bundled
  `dist/index.js` actually boots under plain `node` (not just `tsx`)
- `docker compose build` succeeds for both the `server` and `nginx` (client)
  images, and the resulting containers serve traffic and reach Postgres/Redis
- Cross-room isolation: movement, chat, and emotes never leak to sockets in a
  different room
- Privilege escalation: joining a room while claiming another user's id
  (without their JWT) does not grant admin/owner rights
- Deleting a room via the REST endpoint notifies and disconnects any sockets
  currently inside it
- Zone-scoped chat only reaches sockets that emitted `zone:enter` for that zone
- Avatar config round-trips correctly through `PUT /api/users/me/avatar` and
  `GET /api/auth/me`
- Auth rate limiting kicks in after repeated login/register attempts

To re-run the equivalent checks yourself, write a throwaway Node script using
`socket.io-client` + `fetch` against a running dev server (see git history
around 2026-07-05 for the exact pattern used during this QA pass) — register
two accounts, open two sockets, join rooms, and assert on the events each
socket does/doesn't receive. Delete the script when done; it's not meant to be
a committed test suite.

## Known gaps (not bugs, just not built yet)

- No automated browser/E2E test suite exists — this checklist is manual by
  design until one is added.
- No dedicated TURN server; WebRTC will fail behind symmetric NAT/restrictive
  firewalls in production (only a public STUN server is configured).
- Mobile-responsive layout is not implemented (desktop-only by design so far).
- Large-room performance (many simultaneous players) hasn't been load-tested.
