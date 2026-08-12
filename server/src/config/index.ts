import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-secret-change-in-production';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().default(3001),
    // The database name is deliberately 'kaispace', NOT the 'virtualmeet' this
    // codebase was forked from: that other name belongs to a SEPARATE product
    // whose own deployment still runs against it. This value is a fallback for
    // when DATABASE_URL is unset, so if it named the shared database, a missing
    // or mistyped .env would silently connect this app to the other product's
    // data and migrate/drop columns out from under it — a failure that looks
    // like nothing at all until something is already destroyed. Keep these two
    // names distinct.
    DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/kaispace'),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().default(DEV_JWT_SECRET),
    // 30d, not 7d — this is a "sign in once, stay signed in" app, not a
    // banking app; combined with the sliding-expiry refresh in
    // GET /auth/me (see routes/auth.ts), a user who opens it at least once
    // a month never sees an expired session. Still just an env var, not
    // hardcoded — override per-deployment if a shorter session is wanted.
    JWT_EXPIRES_IN: z.string().default('30d'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    CLIENT_URL: z.string().default('http://localhost:5173'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().default(100),
    // Music Bot (!play chat command) — YouTube Data API v3 search + video
    // lookup. Optional: unset means the bot replies "belum dikonfigurasi"
    // instead of crashing (see lib/youtubeService.ts). See
    // server/.env.example for how to obtain a key.
    YOUTUBE_API_KEY: z.string().optional(),
    // Customer Service chat handoff (Tahap 3/4 — see routes/cs.ts). Both
    // optional so bot-only mode (Tahap 2) works with nothing configured;
    // the handoff endpoints guard on these being set and no-op/error
    // clearly otherwise rather than crashing. Never sent to the client.
    N8N_CS_WEBHOOK_URL: z.string().optional(),
    CS_N8N_TOKEN: z.string().optional(),
    // Google OAuth (Cloud Console) — Basic login only (email + profile),
    // see routes/google.ts. GOOGLE_LOGIN_ENABLED is a SEPARATE explicit
    // gate from the credentials themselves (checked as the literal string
    // 'true', not z.coerce.boolean() — that coercion treats the string
    // "false" as truthy, since Boolean("false") is true) so the button's
    // visibility can be toggled off without touching/removing credentials.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
    GOOGLE_LOGIN_ENABLED: z.string().optional(),
    // Deployment operator — a read-only cross-org view (server/src/routes/
    // operator.ts), gated to exactly the emails listed here. Comma-
    // separated, e.g. "you@example.com,other@example.com". Unset or empty
    // means nobody has access — see lib/operator.ts's isOperatorEmail().
    OPERATOR_EMAILS: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // The default JWT secret is a well-known literal — anyone can forge valid
    // tokens with it, so it must never be allowed to silently apply in production.
    if (val.NODE_ENV === 'production' && val.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be set to a real secret when NODE_ENV=production',
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

let config: EnvConfig;

export function loadConfig(): EnvConfig {
  if (!config) {
    config = envSchema.parse(process.env);
    // Zod's .default() only affects the VALUE this function returns — it
    // never mutates process.env itself. Prisma reads DATABASE_URL straight
    // from process.env (via schema.prisma's env("DATABASE_URL")), completely
    // bypassing this config module, so when the var is genuinely unset (no
    // .env file loaded), Prisma throws "Environment variable not found"
    // even though config.DATABASE_URL itself resolved to a sensible local
    // default. Writing the resolved value back keeps every consumer — ours
    // and Prisma's — looking at the same effective value.
    process.env.DATABASE_URL = config.DATABASE_URL;
  }
  return config;
}

export function getConfig(): EnvConfig {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  return config;
}
