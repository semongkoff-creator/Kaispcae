-- Room join approval: invite-link joins wait for an admin decision.
--
-- Additive. Every existing RoomMember row defaults to status='active', so
-- nobody currently in a room is affected.

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "RoomMember" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateIndex
CREATE INDEX "RoomMember_roomId_status_idx" ON "RoomMember"("roomId", "status");

-- Rooms that already existed keep their current walk-in behaviour. The column
-- defaults to true so NEW rooms are gated, but applying that default
-- retroactively would put every live room behind an approval queue that no
-- admin knows to check — locking out everyone using them right now, including
-- people already standing in them. Opt-in per room from the room settings
-- instead.
UPDATE "Room" SET "requiresApproval" = false;
