import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-secret-change-in-production';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/virtualmeet'),
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
    // Lark (larksuite.com) OAuth — all optional so the app runs fine without
    // them; the Lark login route just reports "not configured" when any is
    // missing (see routes/lark.ts). Never hardcoded — only ever from .env.
    LARK_APP_ID: z.string().optional(),
    LARK_APP_SECRET: z.string().optional(),
    LARK_REDIRECT_URI: z.string().optional(),
    // Optional fallback: employee_id of an admin to set as the punch record's
    // creator_id IF self-punch (creator = the user themselves) is rejected by
    // Lark. Leave unset to only ever self-punch. See lib/larkAttendance.ts.
    LARK_ATTENDANCE_CREATOR_ID: z.string().optional(),
    // A3 — Lark Base (Bitable) activity_log target. Optional: when unset, the
    // activity logging in lib/larkBase.ts is a guarded no-op. Set both once the
    // table exists and the bitable scope is granted.
    LARK_BITABLE_APP_TOKEN: z.string().optional(),
    LARK_BITABLE_ACTIVITY_TABLE_ID: z.string().optional(),
    // Bagian 4 — Lark Event Subscription (inbound webhook /api/lark/events).
    // Both optional so the app runs without the chat-sync feature; the webhook
    // rejects EVERY request (500-safe: returns 404-like ignore) until both are
    // set. LARK_ENCRYPT_KEY decrypts the AES-256-CBC event payload;
    // LARK_VERIFICATION_TOKEN is checked against the event's token field. Get
    // both from Lark Console → Event Subscription. Never hardcoded.
    LARK_ENCRYPT_KEY: z.string().optional(),
    LARK_VERIFICATION_TOKEN: z.string().optional(),
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
