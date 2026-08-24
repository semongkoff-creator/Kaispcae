import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(100),
  displayName: z.string().min(1).max(30),
});

export const createOrganizationSchema = z.object({
  orgName: z.string().trim().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  displayName: z.string().min(1).max(30),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const createRoomSchema = z.object({
  name: z.string().min(1).max(50),
  maxPlayers: z.number().int().min(2).max(100).optional(),
  isPublic: z.boolean().optional(),
  theme: z.enum(['modern-interiors', 'scifi-office']).optional(),
  template: z.enum(['main-office', 'small-team', 'open-lounge', 'blank']).optional(),
});

// Same length cap as createRoomSchema's own `name` — a renamed room is still
// bound by whatever a freshly-created one would be.
export const renameRoomSchema = z.object({
  name: z.string().min(1).max(50),
});

export const avatarUpdateSchema = z.object({
  bodyShape: z.string().optional(),
  color: z.string().optional(),
  accessory: z.string().optional(),
  expression: z.string().optional(),
  name: z.string().max(20).optional(),
  statusTag: z.string().max(10).optional(),
  // Pixel-art sprite system (shared/types/index.ts's AvatarConfig) — added
  // for Bug 2's persist-on-rename fix. Without these, safeParse's default
  // strip-unknown-keys behavior silently dropped every sprite field from
  // req.body before it reached the DB write: a pixel-avatar player's rename
  // would save fine, but their body/eyes/outfit/hair sprite picks would
  // vanish from the PERSISTED config (overwritten with an object missing
  // them) the moment this endpoint was called with a sprite-mode config.
  spriteMode: z.string().optional(),
  bodyId: z.string().optional(),
  eyesId: z.string().optional(),
  outfitId: z.string().optional(),
  hairId: z.string().optional(),
  spriteAccessoryId: z.string().optional(),
  premadeId: z.string().optional(),
});

// specs/2026-08-21-full-name-field-design.md — no `.min(1)`: an empty
// string is a valid submission and means "clear the field back to null"
// (see the route below), not an invalid one. 100 chars is generous
// compared to displayName's 20-char nametag cap — a real full name is
// often longer than a casual nickname.
export const fullNameSchema = z.object({
  name: z.string().max(100),
});

export function sanitizeChat(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .slice(0, 500)
    .trim();
}

export const movePayloadSchema = z.object({
  x: z.number(),
  y: z.number(),
  direction: z.enum(['up', 'down', 'left', 'right']),
});

export const createChannelSchema = z.object({
  name: z.string().min(1).max(30),
});

export const startDmSchema = z.object({
  otherUserId: z.string().min(1),
});

