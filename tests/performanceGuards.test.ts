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

test('live reference images are cropped to the viewport before drawing', () => {
  const source = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');
  const start = source.indexOf('function drawLiveReferenceImage');
  const end = source.indexOf('// ZEP-style spotlight');
  assert.notEqual(start, -1, 'expected the live reference-image draw helper');
  assert.notEqual(end, -1, 'expected the helper boundary comment');
  const helper = source.slice(start, end);

  assert.ok(helper.includes('viewW') && helper.includes('viewH'), 'the helper must know the visible viewport');
  assert.ok(helper.includes('drawLeft') && helper.includes('sourceX'), 'it should derive a destination/source crop');
  assert.equal(
    helper.includes('img.naturalWidth, img.naturalHeight, ref.x - cameraX, ref.y - cameraY, ref.width, ref.height'),
    false,
    'drawing the whole uploaded floor-plan every frame is what made the static layer expensive',
  );
  assert.ok(
    source.includes('drawLiveReferenceImage(ctx, liveReferenceImageRef.current, cameraX, cameraY, worldViewW, worldViewH)'),
    'the call site must pass the current viewport bounds',
  );
  assert.ok(source.includes("mark('liveReferenceImage')"), 'reference-image cost must not be hidden under furnitureObject again');
});

test('layered avatars are composited once per animation frame instead of redrawing every layer', () => {
  const source = readFileSync(resolve('client/src/components/canvas/AvatarSprite.ts'), 'utf8');
  assert.ok(source.includes('layeredSpriteCache'), 'layered avatar frames should have a composed-frame cache');
  assert.ok(source.includes('LAYERED_AVATAR_CACHE_LIMIT'), 'the cache must stay bounded');
  assert.ok(source.includes('layeredAvatarCacheKey'), 'cache identity must include config, direction, frame, and display size');
  assert.ok(
    source.includes('ctx.drawImage(cached') || source.includes('ctx.drawImage(canvas'),
    'hot frames should blit one composed sprite instead of every generator layer',
  );
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

test('every prop crossing GameCanvas\'s memo barrier is stable', () => {
  // GameCanvas is memo()'d on purpose: 3490 lines, 127 hooks, and its JSX
  // carries every DOM overlay in the room. One prop built inline — a single
  // arrow function among 35 — defeated that comparison on EVERY App render,
  // and App re-renders several times a second whenever anyone nearby moves.
  // A memo barrier is only a barrier if nothing unstable crosses it.
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8').split('\n');
  const start = app.findIndex((l) => l.includes('<GameCanvas'));
  assert.notEqual(start, -1, 'expected GameCanvas to be rendered from App');
  let end = start;
  for (let i = start; i < app.length; i++) {
    if (app[i].includes('/>')) { end = i; break; }
  }
  const props = app.slice(start, end + 1);
  const unstable = props.filter((l) => /=\{(\(|\[|\{|new |Object\.)/.test(l)).map((l) => l.trim());
  assert.deepEqual(unstable, [],
    `build these with useCallback/useMemo instead: ${unstable.join(' | ')}`);
  assert.ok(
    readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8').includes('memo(GameCanvasImpl)'),
    'and the barrier itself must stay in place',
  );
});

test('the avatar frame cache is bigger than its own working set', () => {
  const source = readFileSync(resolve('client/src/components/canvas/AvatarSprite.ts'), 'utf8');
  const framesPerDirection = Number(source.match(/const FRAMES_PER_DIRECTION = (\d+);/)?.[1]);
  const limit = Number(source.match(/const LAYERED_AVATAR_CACHE_LIMIT = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(framesPerDirection) && Number.isFinite(limit));

  // 4 directions x frames x 3 rows (idle, walk, sit) distinct frames per
  // outfit, times a roomful of people in differing outfits. A cache smaller
  // than its working set is worse than none: FIFO eviction throws entries out
  // before reuse, so every avatar re-composites continuously and each
  // re-composite touches all the layer spritesheets again. The first version
  // capped at 240 against a working set of ~1300 and produced exactly the
  // episodic 200-290ms frames it was added to remove.
  // 18 was the old target and is no longer the room size to design for: an
  // all-hands is 30 people in one Zone, where zone membership overrides the
  // distance rule and everyone renders at once. At 18 this guard passed while
  // a 30-person room sat 160 entries over the cap and thrashed.
  const perOutfit = 4 * framesPerDirection * 3;
  const roomful = perOutfit * 30;
  assert.ok(limit >= roomful, `${limit} entries cannot hold ${roomful} (30 outfits x ${perOutfit} frames)`);

  // Count alone is the wrong bound — an entry's size grows with zoom and dpr.
  assert.ok(source.includes('LAYERED_AVATAR_CACHE_PIXEL_BUDGET'), 'memory needs its own bound');
  assert.ok(source.includes('layeredSpriteCachePixels'), 'and that bound has to be tracked, not assumed');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} performance guard test(s) passed`);
