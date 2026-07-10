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

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const createRoomSchema = z.object({
  name: z.string().min(1).max(50),
  maxPlayers: z.number().int().min(2).max(100).optional(),
  isPublic: z.boolean().optional(),
  theme: z.enum(['modern-interiors', 'scifi-office']).optional(),
  template: z.enum(['main-office', 'small-team', 'open-lounge']).optional(),
});

export const avatarUpdateSchema = z.object({
  bodyShape: z.string().optional(),
  color: z.string().optional(),
  accessory: z.string().optional(),
  expression: z.string().optional(),
  name: z.string().max(20).optional(),
  statusTag: z.string().max(10).optional(),
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
