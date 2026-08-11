// Self-serve org creation — turns a free-text organization name into a
// URL-safe slug CANDIDATE. This is deliberately just the pure
// name-to-string transform; collision handling (the -2, -3, ... suffix
// when a slug is already taken) happens at the call site via a
// create-and-retry-on-P2002 loop, not here — a separate "is this slug
// free" check followed by a create would leave a race window between
// the check and the actual insert under concurrent signups.
export function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'org';
}
