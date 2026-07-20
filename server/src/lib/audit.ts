import { PrismaClient } from '@prisma/client';
import { Request } from 'express';

// The single writer for the audit trail. Every module (Base, Docs, Calendar,
// Attendance) records through here so the log has one shape and one table.
//
// Deliberately append-only: this module exposes no update or delete. If a
// record could be edited, the log would be worthless as evidence.

export interface AuditInput {
  actorId: string;
  action: string;              // WorkspaceAction, or a module verb like 'base:transfer'
  targetType: string;          // 'base' | 'doc' | 'attendance' | 'user' | 'policy'
  targetId?: string | null;
  targetUserId?: string | null;
  meta?: Record<string, unknown> | null;
  reason?: string | null;
  ip?: string | null;
}

export async function writeAudit(prisma: PrismaClient, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetUserId: input.targetUserId ?? null,
        meta: (input.meta ?? undefined) as never,
        reason: input.reason ?? null,
        ip: input.ip ?? null,
      },
    });
  } catch (err) {
    // Never let an audit failure break the action the user asked for — but do
    // make the gap loud, because a silently missing audit row is exactly the
    // thing this table exists to prevent.
    console.error('[audit] FAILED to write audit entry:', input.action, err);
  }
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}
