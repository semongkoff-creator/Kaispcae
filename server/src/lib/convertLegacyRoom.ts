import { getPrisma } from './prisma';
import {
  RoomTile, RoomTheme, Furniture, Zone, LayerData,
  createDefaultOfficeLayout, legacyToLayerData, layerDataToLegacy, MAP_FORMAT_VERSION,
} from '@virtualmeet/shared';

// ZEP Room Editor — Potong 1 lazy migration. Converts ONE room's legacy map
// (tilemapData/furniture/zones) into the new LayerData format, exactly once,
// the first time it's opened in the new editor. Never touches the legacy columns
// (kept as archive/fallback). Idempotent: a room that already has layerData is
// returned untouched.
//
// SAFETY: before persisting, it round-trips legacy → LayerData → legacy and
// verifies the result is byte-for-byte identical to the runtime shape the game
// currently renders (same normalization as roomHandler's room:state build). If
// anything doesn't reconstruct exactly, it does NOT convert — the room simply
// stays on the legacy path, so a converter edge case can never corrupt a live
// room. That guarantee is the whole point of this being the "riskiest potong".

// Deterministic, key-order-independent stringify (drops undefined like JSON) so
// the round-trip comparison isn't fooled by object key ordering.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Reproduce EXACTLY what roomHandler.ts builds for room:state, so the data we
// convert is the same data players see today.
function resolveLegacyRuntime(dbRoom: {
  tilemapData: unknown; furniture: unknown; zones: unknown; theme?: string | null;
}): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const theme: RoomTheme = dbRoom.theme === 'scifi-office' ? 'scifi-office' : 'modern-interiors';

  let savedTiles: RoomTile[][] | undefined;
  if (Array.isArray(dbRoom.tilemapData) && (dbRoom.tilemapData as unknown[]).length > 0) {
    savedTiles = (dbRoom.tilemapData as Record<string, unknown>[][]).map((row, y) =>
      row.map((t, x) => ({ ...(t as object), x, y, type: (t as { type?: string }).type || 'floor' } as RoomTile)),
    );
  }
  const savedFurniture = Array.isArray(dbRoom.furniture) ? (dbRoom.furniture as Furniture[]) : undefined;
  const savedZones = Array.isArray(dbRoom.zones) ? (dbRoom.zones as Zone[]) : undefined;

  const fallback = (!savedTiles || !savedFurniture || !savedZones) ? createDefaultOfficeLayout(theme) : null;
  return {
    tiles: savedTiles || fallback!.tiles,
    furniture: savedFurniture || fallback!.furniture,
    zones: savedZones || fallback!.zones,
  };
}

export interface ConvertResult {
  converted: boolean;
  alreadyConverted?: boolean;
  reason?: string;
  layerData?: LayerData;
}

export async function convertLegacyRoom(roomId: string): Promise<ConvertResult> {
  const prisma = getPrisma();
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, tilemapData: true, furniture: true, zones: true, theme: true, layerData: true },
  });
  if (!room) return { converted: false, reason: 'not_found' };

  // Idempotent — already converted.
  if (room.layerData) return { converted: false, alreadyConverted: true, layerData: room.layerData as unknown as LayerData };

  const legacy = resolveLegacyRuntime(room);
  const layerData = legacyToLayerData(legacy.tiles, legacy.furniture, legacy.zones);

  // Round-trip identity guard.
  const back = layerDataToLegacy(layerData);
  const ok =
    stableStringify(back.tiles) === stableStringify(legacy.tiles) &&
    stableStringify(back.furniture) === stableStringify(legacy.furniture) &&
    stableStringify(back.zones) === stableStringify(legacy.zones);

  if (!ok) {
    console.error(`[convertLegacyRoom] round-trip MISMATCH for room ${roomId} — leaving it on the legacy path (not converted)`);
    return { converted: false, reason: 'roundtrip_mismatch' };
  }

  await prisma.room.update({
    where: { id: roomId },
    data: { layerData: layerData as unknown as object, mapFormatVersion: MAP_FORMAT_VERSION },
  });
  console.log(`[convertLegacyRoom] room ${roomId} converted to layerData v${MAP_FORMAT_VERSION}`);
  return { converted: true, layerData };
}
