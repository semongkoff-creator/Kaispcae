// Multi-tenant foundation (Fase 1) — the single org every existing account
// and room was backfilled into (see prisma/migrations/20260811210000_org_foundation).
// Every User/Room create site needs an organizationId now that the column is
// required; until the invite-based join flow (a later phase) resolves a real
// org per signup, new rows land here too — same behavior as today, where
// there is only one workspace. Centralized so there's exactly one literal to
// update once that flow exists, instead of a hardcoded string repeated at
// every call site.
export const DEFAULT_ORG_ID = 'org_kaitech_default';
