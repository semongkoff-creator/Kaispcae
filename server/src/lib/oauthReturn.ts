// Where an OAuth callback sends the browser back to.
//
// Both providers used to bounce to `/?larkCode=…` / `/?googleCode=…`, and that
// was right for as long as the app owned the root path. It no longer does:
// kaispace.io/ serves the marketing site, and the app lives at /login, /logout
// and /@slug (see deploy/kaispace/nginx-host.conf, which routes exactly those
// prefixes to the app container).
//
// So the authorization would succeed, Lark would hand back a valid one-time
// code, and the browser would land on the landing page carrying it — where
// nothing reads it. useAuth.ts is the only consumer, and it only runs inside
// the app. From the outside it looked like Lark login silently did nothing.
//
// Relative, not absolute: the browser already arrived on the right origin, so
// this cannot be pointed at a stale CLIENT_URL by a misconfigured .env.
const APP_ENTRY = '/login';

export function oauthReturn(query: string): string {
  return `${APP_ENTRY}?${query}`;
}
