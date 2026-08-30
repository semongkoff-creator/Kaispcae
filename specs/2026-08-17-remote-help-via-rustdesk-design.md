# Minta Bantuan Remote (via RustDesk) — Design

## Context

KaiSpace has no remote-desktop-control feature today, and cannot build one itself: a browser cannot control another machine's OS. The request is for KaiSpace to act purely as a **consent-gated "door"** onto RustDesk (an existing open-source remote-desktop tool) — KaiSpace handles the request/approve/decline handshake and an audit trail; the actual remote-control session runs entirely outside the web app, in RustDesk's own native client.

RustDesk's self-hosted, open-source relay (`hbbs`/`hbbr`) has no API for programmatic session/credential generation — that capability exists only in RustDesk Pro (paid), which is not assumed available. So KaiSpace's role is limited to relaying whatever ID+password the target types in themselves, once both sides have consented — never generating or storing RustDesk credentials.

This session's codebase research found three existing patterns this feature builds on directly, rather than inventing new ones:
- **Consent handshake**: `server/src/socket/followHandler.ts` (the "Follow" feature) — request → real-time prompt (`client/src/components/ui/PendingRequestToast.tsx`, already shared across Follow/Summon/join-room/CEO-queue) → approve/decline → result, with a 20s auto-decline timeout (`CONSENT_REQUEST_TIMEOUT_MS`) and pure in-memory state (no DB table for the live handshake).
- **Audit trail**: `server/src/lib/audit.ts`'s `writeAudit()` + the `AuditLog` model — already the established way to record "who did what to whom, when" without recording the activity's content.
- **UI entry point**: `client/src/components/ui/PlayerCard.tsx` already has a `flex flex-col gap-1` action list (Send Message, Follow, Copy Outfit) that a new action slots into identically, wired from `client/src/App.tsx`.

## Goals

- Any user can request remote help from any other user (peer-to-peer, no role/department restriction — confirmed via clarifying question, matching how Follow already works).
- The target is always the one who decides: sees a real-time approve/decline prompt, and nothing happens without an explicit approve.
- Once approved, the target (not KaiSpace) supplies their own RustDesk ID+password by typing it into a KaiSpace field; KaiSpace relays that string once, live, to the approving helper's socket only — never persisted to Postgres, never localStorage/sessionStorage.
- Both sides can end the KaiSpace-tracked session at any time via a visible "Selesai" control.
- Every request, decision, and end-of-session is written to `AuditLog` — a consent record, not a surveillance log (no session content is ever captured, because KaiSpace never has access to it).

## Non-goals

- KaiSpace does not perform, proxy, or record any remote-control traffic — that is 100% RustDesk, off this app entirely.
- No automatic RustDesk credential generation (would require RustDesk Pro's API — not assumed available; documented as a possible future upgrade that would not change anything on the KaiSpace side except which instructions are shown).
- No silent/forced/admin-observer mode of any kind. A request that can't guarantee the target's real-time, revocable consent is out of scope, full stop.
- KaiSpace's "Selesai" control cannot force-disconnect an active RustDesk session — that is only possible from RustDesk's own native client (which always has its own visible disconnect control). This is called out explicitly in the UI copy so the control's actual guarantee (ends KaiSpace's tracking + notifies the other party) is never overstated as "kills the remote connection."
- No role/department scoping for who can request or offer help (per the clarifying-question answer) — every user can act on every other user's player card.
- No persistent "remote help session" DB table — `AuditLog` already gives a durable record of request/decide/end; the live handshake state is as ephemeral as Follow's.

## Architecture

New files, mirroring `followHandler.ts`'s shape exactly:

- `server/src/socket/remoteHelpHandler.ts` — new handler, registered alongside `registerFollowHandlers` etc. Holds two in-memory maps: `pendingRemoteHelp: Map<requestId, PendingRemoteHelp>` (awaiting decision) and `activeRemoteHelp: Map<targetUid, ActiveRemoteHelp>` (one live session per target, enforced — a second request to an already-helped target is rejected immediately with a clear reason, no prompt shown).
- `shared/types/index.ts` — new `SocketEvents` members: `REMOTE_HELP_REQUEST`, `REMOTE_HELP_INCOMING`, `REMOTE_HELP_RESPOND`, `REMOTE_HELP_RESULT`, `REMOTE_HELP_CREDENTIAL` (target → helper, the one-time ID+password relay), `REMOTE_HELP_END`. Named in the same family as the existing `FOLLOW_*` events.
- `client/src/components/ui/PlayerCard.tsx` — one new conditional action button (`onRequestRemoteHelp`), same gating idiom as `onSendMessage`.
- `client/src/App.tsx` — wires the new prop, reuses `PendingRequestToast.tsx` for the incoming prompt (no new toast component).
- `client/src/components/ui/RemoteHelpBanner.tsx` — new small component: shown to both target and helper once a session is active, states who's helping/being helped, and a "Selesai" button. Copy explicitly says ending this only stops KaiSpace's tracking, not the RustDesk connection itself.
- `client/src/components/ui/RemoteHelpCredentialForm.tsx` — new small component: shown to the target only, immediately after they approve. One text input ("ID+password RustDesk kamu"), one submit button. Submitting emits `REMOTE_HELP_CREDENTIAL` once; the input is cleared from component state immediately after (never written to any storage).

## Data flow

```
A clicks "Minta bantuan remote" on B's player card
  → REMOTE_HELP_REQUEST (server generates requestId, checks B has no active session already)
  → server emits REMOTE_HELP_INCOMING to B; writeAudit('remoteHelp:request')
  → B sees PendingRequestToast (approve/decline), 20s auto-decline timeout (CONSENT_REQUEST_TIMEOUT_MS)
  → B responds → REMOTE_HELP_RESPOND
  → server writeAudit('remoteHelp:decide'); emits REMOTE_HELP_RESULT to A
      declined/timeout → done, nothing further happens
      accepted → server marks activeRemoteHelp[B] = {helperUid: A, startedAt}
                 → both A and B's clients show RemoteHelpBanner
                 → B's client additionally shows RemoteHelpCredentialForm
  → B types their RustDesk ID+password, submits → REMOTE_HELP_CREDENTIAL
  → server relays the string ONCE, directly to A's socket only (never written anywhere) → clears from server memory immediately after relay
  → A pastes it into their own RustDesk client to connect (entirely outside KaiSpace from here)
  → either A or B clicks "Selesai" on RemoteHelpBanner → REMOTE_HELP_END
  → server deletes activeRemoteHelp[B]; writeAudit('remoteHelp:end'); notifies the other party; both banners clear
```

## Error handling

- Target already in an active session: the new request is rejected server-side before any prompt is shown to the target — requester gets a clear "B sedang dibantu orang lain" result, same shape as a decline.
- Target offline or doesn't respond within `CONSENT_REQUEST_TIMEOUT_MS` (20s): auto-declined, same as Follow's existing timeout path.
- Either party disconnects mid-session (tab closed, crash): treated the same as an explicit `REMOTE_HELP_END` — the other party is notified and `writeAudit('remoteHelp:end')` records the reason as `'disconnect'`, mirroring `followHandler.ts`'s own `DISCONNECT` cleanup.
- Requester disconnects while a request is still pending (target hasn't responded yet): the pending entry is discarded silently, same as `followHandler.ts`'s pending-request disconnect cleanup — no prompt is left dangling on the target's screen for a requester who's already gone.
- The credential field has no format validation — KaiSpace has no way to know what a valid RustDesk ID/password looks like, and validating would mean parsing/understanding data it should touch as little as possible. Any string the target submits is relayed as-is.
- The relay step (`REMOTE_HELP_CREDENTIAL`) only succeeds if the helper's socket is still connected and still marked as the active session's helper — a stale/already-ended session cannot receive a credential.

## Security & privacy

- The RustDesk ID+password string exists in server memory only for the duration of one relay call — never written to Postgres, never `localStorage`/`sessionStorage`, never included in any `writeAudit()` `meta` payload (audit records the fact of the session, never its credential).
- No new per-org credential storage is introduced — KaiSpace does no remote-control work itself, so unlike `orgIntegration.ts`'s per-org pattern, at most a single static instructional text (which relay to use / where to download RustDesk) is needed, configured via one plain env var if it ever needs to change from the RustDesk public default — same convention as `VITE_TURN_URL`.
- No admin override, no "view without approval," no way to start a session without the target's explicit real-time approve.

## Testing

Same convention as this session's other features: `npm run typecheck`/build after each implementation step, then a live smoke test against the real local dev server + Postgres (client :5173, server :3001) using two real logged-in throwaway users in two browser sessions — request → approve → credential relay → both banners → Selesai from each side independently — plus the reject/timeout/already-active-session paths, before this is considered done.
