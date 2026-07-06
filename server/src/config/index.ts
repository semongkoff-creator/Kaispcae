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
  }
  return config;
}

export function getConfig(): EnvConfig {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  return config;
}
