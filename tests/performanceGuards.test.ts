import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldIsolateZoneAudio, TRANSLUCENT_THRESHOLD, Zone } from '../shared/types';
import { calcGain } from '../client/src/hooks/useProximity';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const zone = (overrides: Partial<Zone>): Zone => ({
  id: 'zone',
  name: 'Zone',
  x: 0,
  y: 0,
  width: 4,
  height: 4,
  type: 'desk',
  ...overrides,
});

test('large desk areas do not become one giant RTC group by default', () => {
  assert.equal(shouldIsolateZoneAudio(zone({ width: 20, height: 12, type: 'desk' })), false);
});

test('normal desk rooms still isolate audio by default', () => {
  assert.equal(shouldIsolateZoneAudio(zone({ width: 6, height: 6, type: 'desk' })), true);
});

test('explicit audio isolation setting wins over size heuristic', () => {
  assert.equal(shouldIsolateZoneAudio(zone({ width: 20, height: 12, audioIsolated: true })), true);
  assert.equal(shouldIsolateZoneAudio(zone({ width: 4, height: 4, audioIsolated: false })), false);
});

test('mesh peer caps stay conservative for crowded office areas', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  assert.match(source, /export const MAX_TOTAL_PEERS = 8;/);
  assert.match(source, /export const MAX_VIDEO_PEERS = 4;/);
});

test('proximity gain remains audible at the translucent edge', () => {
  assert.ok(calcGain(TRANSLUCENT_THRESHOLD) > 0, 'edge-of-range peer should not be fully muted');
});

test('connection HUD does not spam full peer lists into DevTools', () => {
  const source = readFileSync(resolve('client/src/components/ui/ConnectionIndicator.tsx'), 'utf8');
  assert.equal(source.includes('[HUD] ConnectionIndicator'), false);
});

test('client WebRTC lifecycle logs stay behind diagnostics', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  assert.equal(source.includes("console.log('[webrtc]"), false);
});

test('movement collision areas are cached outside hot callbacks', () => {
  const source = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');
  assert.equal(source.includes('getImpassableAreas: () => [...impassableAreaRectsRef.current, ...getLockedDoorAreas()]'), false);
  assert.equal(source.includes('const areas = [...impassableAreaRectsRef.current, ...getLockedDoorAreas()]'), false);
  assert.ok(source.includes('movementCollisionAreasRef'), 'movement collision areas should be cached in a ref');
});

test('server nearby broadcast uses the shared zone isolation rule', () => {
  const source = readFileSync(resolve('server/src/socket/proximityBroadcast.ts'), 'utf8');
  assert.ok(source.includes('shouldIsolateZoneAudio'), 'server broadcast must not treat every labelled zone as isolated');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} performance guard test(s) passed`);
