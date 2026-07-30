# LimeZu Asset Pack Import Guide

The 339 LimeZu Modern Office singles are already in:
```
client/public/assets/tilesets/modern-office/Modern_Office_Singles_32x32/
```

**Three scripts handle the import pipeline:**

## Step 1: Generate Manifest (No dependencies)

```bash
node scripts/importLimeZuAssets.mjs
```

This script:
- ✅ Reads all 339 PNG files
- ✅ Verifies dimensions are divisible by 32 (TILE_SIZE)
- ✅ Generates `client/src/data/limezu-office-manifest.ts` with PaletteEntry objects
- ✅ Reports any anomalies (dimensions not 32-aligned)

**Output:** `limezu-office-manifest.ts` with all 339 entries + estimated tile dimensions.

**Note:** Tile dimensions use a conservative estimate (standard 64×96 canvas, bottom-anchored 2×2 content). For pieces taller/wider than 2 tiles, you may need to manually adjust:
- `tilesH: 3` for tall plants
- `srcY: 0` for pieces that fill the whole canvas
- etc.

## Step 2: Integrate Manifest

```bash
node scripts/integrateManifest.mjs
```

This script:
- ✅ Adds `import { LIMEZU_OFFICE_ENTRIES }` to tilePaletteManifest.ts
- ✅ Inserts `...LIMEZU_OFFICE_ENTRIES,` into the TILE_PALETTE array
- ✅ Preserves all existing entries (no deletions)

## Step 3: Test in Room Editor

```bash
npm run dev
```

Then open http://localhost:5173 (client) and navigate to a room editor. The Objects pane should now show ~339 new "LimeZu Office NNN" entries.

**Verify:**
1. ✅ Palet Objects menampilkan objek LimeZu dengan thumbnail tajam (tidak blur)
2. ✅ Tempatkan objek 2×3 → snap grid sempurna, ghost/footprint benar
3. ✅ Zoom in/out → pixel tetap tajam (imageSmoothingEnabled = false sudah ada)
4. ✅ Furniture lama tetap tampil & bisa diduduki

## Manual Refinement (Optional)

If some entries have incorrect tile dimensions:
1. Open `client/src/data/limezu-office-manifest.ts`
2. Find entries needing adjustment
3. Update `srcX`, `srcY`, `tilesW`, `tilesH` based on visual inspection
4. Save and `npm run dev` to re-test

Example:
```ts
{
  id: 'limezu-office-047',
  label: 'LimeZu Office 47',   // Tall plant
  category: 'furniture',
  src: '/assets/tilesets/modern-office/Modern_Office_Singles_32x32/Modern_Office_Singles_32x32_47.png',
  srcX: 0,
  srcY: 0,        // Changed from 32 → 0 (content fills whole canvas)
  tilesW: 2,      // Usually stays 2 (64px width)
  tilesH: 3,      // Changed from 2 → 3 (height > 64px)
}
```

## Anomalies

If `importLimeZuAssets.mjs` reports anomalies (dimensions not divisible by 32), they are still added to the manifest but flagged. Most should be fine — the script reports the issue but doesn't block. Check visually in the editor if concerned.

## Cleanup

After testing:
- `.gitignore` already excludes node_modules, dist/, server/uploads/
- Script outputs (manifests) ARE committed
- Keep `limezu-office-manifest.ts` and script changes in git
