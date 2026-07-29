-- ZEP Room Editor (Potong 1) — new layered map format, stored beside the legacy
-- tilemapData/furniture/zones columns. Both nullable: existing rooms are NOT
-- touched and keep rendering via the legacy path until lazily converted.
ALTER TABLE "Room" ADD COLUMN "layerData" JSONB;
ALTER TABLE "Room" ADD COLUMN "mapFormatVersion" INTEGER;
