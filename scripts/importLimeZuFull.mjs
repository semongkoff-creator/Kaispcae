#!/usr/bin/env node
/**
 * Import LENGKAP LimeZu Modern Interiors (5.470 objek, 24 tema)
 *
 * Pipeline:
 * 1. Extract moderninteriors-win.zip
 * 2. Scan 24 tema × Theme_Sorter_Singles_32x32
 * 3. Copy PNG per-tema → client/public/assets/limezu-interiors/{tema}/
 * 4. Generate per-tema manifest.json (lazy-load)
 * 5. Process Room_Builder tiles
 * 6. Verify dimensi PNG (divisible by 32)
 * 7. Report anomali
 *
 * Usage: node scripts/importLimeZuFull.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import unzipper from 'unzipper';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const ZIP_PATH = 'C:/Users/farel/Downloads/moderninteriors-win.zip';
const TEMP_EXTRACT = path.join(repoRoot, '.temp-limezu-extract');
const ASSETS_BASE = path.join(repoRoot, 'client/public/assets/limezu-interiors');
const TILE_SIZE = 32;

// Theme mapping: folder name → clean category name
const THEME_NAMES = {
  '01_Bedroom': 'Bedroom',
  '02_Hospital': 'Hospital',
  '03_Clothing Store': 'Clothing Store',
  '04_Grocery Store': 'Grocery Store',
  '05_Museum': 'Museum',
  '06_Kitchen': 'Kitchen',
  '07_Jail': 'Jail',
  '08_Classroom': 'Classroom',
  '09_Library': 'Library',
  '10_Basement': 'Basement',
  '11_Halloween': 'Halloween',
  '12_Gym': 'Gym',
  '13_Music': 'Music',
  '14_Sport': 'Sport',
  '15_Bathroom': 'Bathroom',
  '16_Japanese Interiors': 'Japanese Interiors',
  '17_Christmas': 'Christmas',
  '18_Living Room': 'Living Room',
  '19_Ice Cream Shop': 'Ice Cream Shop',
  '20_Condominium': 'Condominium',
  '21_TV & Film Studio': 'TV & Film Studio',
  '22_Fishing': 'Fishing',
  '23_Conference Hall': 'Conference Hall',
  '24_Birthday Party': 'Birthday Party',
  '25_Art': 'Art',
  '26_Shooting Range': 'Shooting Range',
};

// Helper: read PNG IHDR to get dimensions
function getPngDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  } catch { return null; }
}

// Helper: clean theme name from folder
function cleanThemeName(folderName) {
  // Remove leading number and underscore: "01_Bedroom_Singles_32x32" → "Bedroom"
  const match = folderName.match(/^\d+_(.+?)_Singles_32x32$/);
  return match ? match[1] : folderName;
}

// Main
async function main() {
  console.log('🔍 LimeZu Modern Interiors Import Pipeline\n');
  console.log(`📦 Zip: ${ZIP_PATH}`);
  console.log(`📁 Extract: ${TEMP_EXTRACT}`);
  console.log(`🎨 Assets: ${ASSETS_BASE}\n`);

  // Step 1: Extract zip
  console.log('📥 Extracting zip...');
  if (fs.existsSync(TEMP_EXTRACT)) {
    fs.rmSync(TEMP_EXTRACT, { recursive: true });
  }
  fs.mkdirSync(TEMP_EXTRACT, { recursive: true });

  await new Promise((res, rej) => {
    createReadStream(ZIP_PATH)
      .pipe(unzipper.Extract({ path: TEMP_EXTRACT }))
      .on('close', res)
      .on('error', rej);
  });

  console.log('✅ Extracted.\n');

  // Step 2: Find Theme_Sorter_Singles folder
  const themeDir = path.join(TEMP_EXTRACT, '1_Interiors/32x32/Theme_Sorter_Singles_32x32');
  if (!fs.existsSync(themeDir)) {
    console.error(`❌ Theme dir not found: ${themeDir}`);
    process.exit(1);
  }

  const themeFolders = fs.readdirSync(themeDir)
    .filter(f => fs.statSync(path.join(themeDir, f)).isDirectory())
    .filter(f => f.includes('_Singles_32x32'))
    .sort();

  console.log(`🎨 Found ${themeFolders.length} theme folders\n`);

  const themeSummary = [];
  const allAnomalies = [];

  // Step 3: Process each theme
  for (const themeFolder of themeFolders) {
    const themePath = path.join(themeDir, themeFolder);
    const cleanName = cleanThemeName(themeFolder);
    const categoryId = cleanName.toLowerCase().replace(/\s+/g, '-');
    const assetPath = path.join(ASSETS_BASE, categoryId);

    fs.mkdirSync(assetPath, { recursive: true });

    const pngFiles = fs.readdirSync(themePath)
      .filter(f => f.endsWith('.png'))
      .sort();

    process.stdout.write(`\r  [${themeFolders.indexOf(themeFolder) + 1}/${themeFolders.length}] ${cleanName}: ${pngFiles.length} objects`);

    const entries = [];
    const anomalies = [];

    for (let i = 0; i < pngFiles.length; i++) {
      const file = pngFiles[i];
      const srcPath = path.join(themePath, file);
      const destPath = path.join(assetPath, file);

      // Copy file
      fs.copyFileSync(srcPath, destPath);

      // Read dimensions
      const dims = getPngDimensions(destPath);
      if (!dims) {
        anomalies.push({ file, reason: 'Failed to read PNG header' });
        continue;
      }

      const { width, height } = dims;

      // Check divisible by TILE_SIZE
      if (width % TILE_SIZE !== 0 || height % TILE_SIZE !== 0) {
        anomalies.push({ file, reason: `${width}×${height} not divisible by 32` });
      }

      // Estimate tiles (same as before: standard 64×96 canvas)
      let tilesW = 2, tilesH = 2, srcY = 32;
      if (width !== 64 || height !== 96) {
        tilesW = Math.ceil(width / TILE_SIZE);
        tilesH = Math.ceil(height / TILE_SIZE);
        srcY = Math.max(0, height - 64);
      }

      const id = `limezu-${categoryId}-${String(i + 1).padStart(3, '0')}`;
      entries.push({
        id,
        label: `${cleanName} ${i + 1}`,
        category: cleanName,
        src: `/assets/limezu-interiors/${categoryId}/${file}`,
        srcX: 0,
        srcY,
        tilesW,
        tilesH,
        footprintRows: 1,
        defaultLayer: 'objects',
      });
    }

    // Generate manifest.json
    const manifestPath = path.join(assetPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), 'utf8');

    themeSummary.push({
      category: cleanName,
      categoryId,
      count: entries.length,
      anomalies: anomalies.length,
    });

    if (anomalies.length > 0) {
      allAnomalies.push({ theme: cleanName, anomalies });
    }
  }

  console.log('\n');

  // Step 4: Report summary
  console.log('📊 Import Summary:\n');
  let totalObjects = 0;
  themeSummary.forEach(t => {
    console.log(`  ${t.category.padEnd(25)} ${String(t.count).padStart(4)} objects${t.anomalies > 0 ? ` (⚠️  ${t.anomalies} anomalies)` : ''}`);
    totalObjects += t.count;
  });

  console.log(`\n  Total: ${totalObjects} objects\n`);

  if (allAnomalies.length > 0) {
    console.log('⚠️  Anomalies:\n');
    allAnomalies.forEach(({ theme, anomalies }) => {
      console.log(`  ${theme}:`);
      anomalies.slice(0, 3).forEach(({ file, reason }) => {
        console.log(`    • ${file}: ${reason}`);
      });
      if (anomalies.length > 3) console.log(`    ... and ${anomalies.length - 3} more`);
    });
    console.log();
  }

  // Step 5: Cleanup
  console.log('🧹 Cleaning up temp folder...');
  fs.rmSync(TEMP_EXTRACT, { recursive: true });

  console.log('\n✅ Import complete!');
  console.log(`📁 Assets: ${ASSETS_BASE}`);
  console.log(`\n📝 Next:\n   1. Implement UI category picker + lazy-load in Room Editor\n   2. Test palet + search\n   3. Verify performance (network tab)\n`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
