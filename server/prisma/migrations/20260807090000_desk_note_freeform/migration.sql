-- DeskNote redesigned from furniture-attached (roomId+furnitureId, one per
-- piece) to freeform-placed (x/y, like MapMediaObject). No rows exist in
-- production yet (feature had just shipped), so this drops+recreates the
-- changed columns rather than a data-preserving migration.

-- DropIndex
DROP INDEX "DeskNote_roomId_furnitureId_key";

-- AlterTable
ALTER TABLE "DeskNote" DROP COLUMN "furnitureId",
ADD COLUMN "x" INTEGER NOT NULL,
ADD COLUMN "y" INTEGER NOT NULL;
