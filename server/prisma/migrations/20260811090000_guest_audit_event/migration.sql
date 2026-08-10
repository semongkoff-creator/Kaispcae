-- QA (Akses tamu checklist item 14, "Audit") — guest visit lifecycle log.
-- Cascades with its RoomInvite so revoking/expiring a link's row cleanup
-- (if the invite itself is ever hard-deleted) doesn't orphan these.
CREATE TABLE "GuestAuditEvent" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GuestAuditEvent_inviteId_idx" ON "GuestAuditEvent"("inviteId");

ALTER TABLE "GuestAuditEvent" ADD CONSTRAINT "GuestAuditEvent_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RoomInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
