#!/usr/bin/env node
/**
 * Integrate limezu-office-manifest.ts into tilePaletteManifest.ts
 *
 * Adds LIMEZU_OFFICE_ENTRIES to TILE_PALETTE array while preserving existing entries.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MANIFEST_FILE = path.join(repoRoot, 'client/src/data/tilePaletteManifest.ts');
const LIMEZU_FILE = path.join(repoRoot, 'client/src/data/limezu-office-manifest.ts');

async function main() {
  // Check that both files exist
  if (!fs.existsSync(LIMEZU_FILE)) {
    console.error(`❌ ${path.basename(LIMEZU_FILE)} not found. Run importLimeZuAssets.mjs first.`);
    process.exit(1);
  }

  let manifest = fs.readFileSync(MANIFEST_FILE, 'utf8');

  // Check if already integrated
  if (manifest.includes('LIMEZU_OFFICE_ENTRIES')) {
    console.log('⚠️  LIMEZU_OFFICE_ENTRIES already in manifest. Skipping integration.');
    process.exit(0);
  }

  // Add import statement after other imports
  const importLine = `import { LIMEZU_OFFICE_ENTRIES } from './limezu-office-manifest';\n`;
  if (!manifest.includes(importLine)) {
    // Find the last import line
    const lastImportMatch = manifest.match(/^import .+ from .+;$/m);
    if (lastImportMatch) {
      const insertAfter = lastImportMatch[0];
      manifest = manifest.replace(insertAfter, `${insertAfter}\n${importLine}`);
    } else {
      // No imports found, add at the top after the comment block
      manifest = manifest.replace(
        /^(\/\/ .+\n)+/m,
        (match) => match + '\n' + importLine
      );
    }
  }

  // Update TILE_PALETTE array to include LIMEZU entries
  const tileArrayMatch = manifest.match(/export const TILE_PALETTE: PaletteEntry\[\] = \[/);
  if (!tileArrayMatch) {
    console.error('❌ Could not find TILE_PALETTE definition.');
    process.exit(1);
  }

  const searchStr = 'export const TILE_PALETTE: PaletteEntry[] = [';
  const replaceStr = `export const TILE_PALETTE: PaletteEntry[] = [\n  ...LIMEZU_OFFICE_ENTRIES,`;

  manifest = manifest.replace(searchStr, replaceStr);

  // Save
  fs.writeFileSync(MANIFEST_FILE, manifest, 'utf8');
  console.log(`✅ Integrated LIMEZU_OFFICE_ENTRIES into ${path.basename(MANIFEST_FILE)}`);
  console.log(`   Next: npm run dev to test in Room Editor`);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
