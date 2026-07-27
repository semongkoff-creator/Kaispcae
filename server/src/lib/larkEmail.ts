// Lark's contact:user.base:readonly scope returns name + avatar + open_id but
// NOT an email. Our User.email is required + unique, so a Lark account with no
// real email gets a deterministic synthetic one keyed on its open_id. Kept in
// one place with a matching detector so other code can tell "this is a
// placeholder, not a real address" (e.g. to hide it, or to prompt the user to
// add a real one later — out of scope for A1, but the check belongs here now).
const SYNTHETIC_DOMAIN = 'meetkai.local';

export function syntheticLarkEmail(openId: string): string {
  return `lark-${openId}@${SYNTHETIC_DOMAIN}`;
}

export function isSyntheticLarkEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(`@${SYNTHETIC_DOMAIN}`);
}
