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
    // Bagian 4 — inbound Lark chat events arrive over the SDK's persistent
    // connection (WSClient, see lib/larkWs.ts), authenticated with the existing
    // LARK_APP_ID/LARK_APP_SECRET. No webhook URL, encrypt key, or verification
    // token needed — hence no extra env vars here.
    //
    // A7 — Daily Task widget reads/writes a specific Lark Base (Bitable) table
    // as its single source of truth. These are non-secret identifiers from the
    // Base URL; defaulted so no VPS env change is needed, overridable per deploy.
    LARK_TASK_APP_TOKEN: z.string().default('UXozb1N5TapUC4s7fu2lpmDigwc'),
    LARK_TASK_TABLE_ID: z.string().default('tbl4HKtwKhDS99pJ'),
    // The linked "Project" table (Related Project field points here) — its
    // records populate the live Project dropdown.
    LARK_TASK_PROJECT_TABLE_ID: z.string().default('tbl6MlZSjIddOZSl'),
    // A8 — root Lark Drive folder that per-room subfolders (chat attachments +
    // recordings) are created under. The app has no personal Drive space, so an
    // admin creates ONE folder, shares it with the app, and puts its
    // folder_token here. Unset → Drive storage is disabled and uploads fall back
    // to local disk (current behaviour). Requires the drive:drive scope.
    LARK_DRIVE_ROOT_FOLDER_TOKEN: z.string().optional(),
    // A9 — Lark Approval "Cuti" (leave) approval_code. Non-secret (an approval
    // definition id); defaulted so the feature works out-of-box, overridable
    // per deploy. Empty → the leave feature is disabled (guarded, never sends an
    // empty code to Lark). The approval uses Lark's native leaveGroupV2 widget.
    LARK_APPROVAL_CODE_CUTI: z.string().default('F6C868F2-7427-450E-8DB4-A9D28A4AC181'),
    // Bagian 4 upgrade — key to encrypt each user's stored Lark OAuth tokens at
    // rest (AES-256-GCM, see lib/tokenCrypto.ts). Any string; it's hashed to a
    // 32-byte key. Unset → user tokens are NOT stored and chat always relays via
    // the bot+prefix fallback. Never printed or committed.
    LARK_TOKEN_ENC_KEY: z.string().optional(),
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
