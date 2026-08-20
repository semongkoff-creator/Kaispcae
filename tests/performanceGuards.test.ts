import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldIsolateZoneAudio, TRANSLUCENT_THRESHOLD, Zone } from '../shared/types';
import { calcGain } from '../client/src/hooks/useProximity';
import { measureTextCached, __clearTextWidthCache } from '../client/src/components/canvas/textMetrics';
import { cullOverlay, setOverlayStyle } from '../client/src/components/canvas/overlayStyle';

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

test('mesh peer caps bound the EXPENSIVE track, not the cheap one', () => {
  // Was pinned to the literal 8/4. That guarded the wrong thing: the total
  // is almost all audio (~40 kbps per peer — free, on any usable
  // connection), and holding it at 8 left members of a crowded audio-
  // isolated area silently unconnected, since the zone rule asks for every
  // member regardless of distance. What actually has to stay small is the
  // number of simultaneous CAMERAS, and (see mediaBudget.ts) the screen
  // share's aggregate upload. So this now asserts the relationship rather
  // than two magic numbers that had to be edited to change a decision.
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  const total = Number(source.match(/export const MAX_TOTAL_PEERS = (\d+);/)?.[1]);
  const video = Number(source.match(/export const MAX_VIDEO_PEERS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(total) && Number.isFinite(video), 'both caps must stay plain exported constants');
  assert.ok(video < total, 'cameras must stay a subset of connected peers');
  assert.ok(video <= 8, `${video} simultaneous cameras is more uplink than a mesh can carry`);
  assert.ok(total <= 24, `${total} peer connections per client is past what a mesh should attempt at all`);
  // A flat per-peer screen-share ceiling is what made a share cost
  // 2.5 Mbps x peers on the presenter's own uplink.
  assert.equal(source.includes('const SCREEN_SHARE_MAX_BITRATE_BPS'), false, 'screen bitrate should come from the aggregate budget');
  assert.ok(source.includes('screenShareBitrateFor(this.peers.size)'), 'the budget must be split by the CURRENT audience size');
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

// Minimal stand-ins — these two modules touch nothing on a real canvas
// context or element beyond what's faked here, which is what lets them be
// tested for behavior rather than by grepping the render loop for the calls.
function fakeCtx(font: string) {
  let measureCalls = 0;
  const ctx = {
    font,
    measureText(text: string) {
      measureCalls++;
      return { width: text.length * 7 } as TextMetrics;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls: () => measureCalls, set font(f: string) { ctx.font = f; } };
}

function fakeElement() {
  const written: string[] = [];
  const el = {
    style: {
      setProperty(prop: string, value: string) {
        written.push(`${prop}=${value}`);
      },
    },
  };
  return { el: el as unknown as HTMLElement, written };
}

test('repeated label measurement hits the cache instead of re-shaping text', () => {
  __clearTextWidthCache();
  const f = fakeCtx('bold 9px sans-serif');
  const first = measureTextCached(f.ctx, '\u{1FA91} Hannif');
  for (let frame = 0; frame < 60; frame++) measureTextCached(f.ctx, '\u{1FA91} Hannif');
  assert.equal(f.calls(), 1, 'the same string in the same font should be measured once, not once per frame');
  assert.equal(measureTextCached(f.ctx, '\u{1FA91} Hannif'), first);
});

test('text width cache keys on the font, not just the string', () => {
  __clearTextWidthCache();
  const f = fakeCtx('bold 9px sans-serif');
  measureTextCached(f.ctx, 'Ravka');
  f.font = 'bold 11px sans-serif';
  measureTextCached(f.ctx, 'Ravka');
  assert.equal(f.calls(), 2, 'a different font must not reuse the previous font\'s width');
});

test('overlay style writes are skipped when the value has not changed', () => {
  const { el, written } = fakeElement();
  setOverlayStyle(el, 'transform', 'translate(10px, 20px)');
  setOverlayStyle(el, 'transform', 'translate(10px, 20px)');
  setOverlayStyle(el, 'transform', 'translate(10px, 20px)');
  assert.deepEqual(written, ['transform=translate(10px, 20px)']);
  setOverlayStyle(el, 'transform', 'translate(11px, 20px)');
  assert.equal(written.length, 2, 'a genuinely changed value must still be written');
});

test('off-screen overlays are hidden and report themselves as culled', () => {
  const onScreen = fakeElement();
  assert.equal(cullOverlay(onScreen.el, 100, 100, 40, 40, 1200, 800), true);
  assert.deepEqual(onScreen.written, ['visibility=visible']);

  const offScreen = fakeElement();
  // Far below the viewport — a zone banner in a part of the office the
  // camera isn't looking at.
  assert.equal(cullOverlay(offScreen.el, 100, 4000, 40, 40, 1200, 800), false);
  assert.deepEqual(offScreen.written, ['visibility=hidden']);
});

test('an overlay just past the edge is not culled while still partly visible', () => {
  const { el } = fakeElement();
  assert.equal(cullOverlay(el, -30, 400, 40, 40, 1200, 800), true, 'a box straddling the left edge is still on screen');
});

test('walking past someone does not immediately negotiate a peer connection', () => {
  const source = readFileSync(resolve('client/src/hooks/useWebRTC.ts'), 'utf8');
  assert.match(source, /const CONNECT_DWELL_MS = \d+;/, 'proximity connect should be gated by a dwell time');
  assert.ok(source.includes('p.viaZone || now - inRangeSince >= CONNECT_DWELL_MS'), 'zone/table-mates must still connect without waiting out the dwell');
});

test('canvas overlays are positioned through the culling/dedup helpers', () => {
  const source = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');
  // A raw style write bypasses both the viewport cull and the "did this
  // actually change" check, and (for transform specifically) also
  // desynchronises setOverlayStyle's own cache.
  assert.equal(/el\.style\.(transform|fontSize|width|height|opacity) =/.test(source), false);
  assert.equal(source.includes('ctx.measureText('), false, 'label widths should come from the cached measurer');
});

test('the minimap redraws player dots without rebuilding the floor plan', () => {
  const source = readFileSync(resolve('client/src/components/hud/Minimap.tsx'), 'utf8');
  // The floor plan pass loops every tile in the room. It used to share one
  // effect with the player dots, whose deps include `players` — an array App
  // rebuilds on every render, up to five times a second from the proximity
  // tick alone. So anyone moving nearby rebuilt the whole map.
  assert.ok(source.includes('staticLayerRef'), 'the floor plan should be cached off-screen');
  assert.ok(source.includes('ctx.drawImage(floorPlan, 0, 0, MM_W, MM_H)'), 'the dot pass should blit it, not redraw it');

  const dotDeps = source.slice(source.lastIndexOf('}, ['));
  for (const churny of ['tiles', 'furniture', 'wallAreaRects', 'zones']) {
    assert.equal(
      dotDeps.includes(churny), false,
      `the dot pass must not depend on ${churny} — that is what made it redraw the map`,
    );
  }

  // Assigning canvas.width reallocates and clears the backing store; the dot
  // pass runs whenever anyone moves, so it must only resize on a real change.
  assert.ok(
    /if \(canvas\.width !== MM_W \* dpr \|\| canvas\.height !== MM_H \* dpr\) \{/.test(source),
    'the canvas should only be resized when its size actually changed',
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} performance guard test(s) passed`);
