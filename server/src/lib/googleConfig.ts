import { getConfig } from '../config';

export interface GoogleOAuthConfig {
  clientId: string;
  secret: string;
  redirect: string;
}

// Single source of truth for "is Google login actually usable right now" —
// shared by routes/google.ts (the real OAuth flow) and routes/auth.ts's
// GET /auth/config (what tells the client whether to even show the
// button), so the two can never drift out of sync with each other. A
// dedicated lib file rather than exporting this out of routes/google.ts
// itself: routes/google.ts imports signToken from routes/auth.ts, so
// auth.ts importing back from google.ts would be a circular module
// dependency — this sits below both instead.
export function googleConfig(): GoogleOAuthConfig | null {
  const c = getConfig();
  if (c.GOOGLE_LOGIN_ENABLED !== 'true') return null;
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.GOOGLE_REDIRECT_URI) return null;
  return { clientId: c.GOOGLE_CLIENT_ID, secret: c.GOOGLE_CLIENT_SECRET, redirect: c.GOOGLE_REDIRECT_URI };
}
