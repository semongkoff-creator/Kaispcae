import { Avatar, BodyShape, Accessory, Expression, Direction, TILE_SIZE } from '@kaispace/shared';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { measureTextCached } from './textMetrics';
import { PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';
import { truncateName } from '@/utils/truncateName';

// Radius for the shape-fallback avatar (drawn only while no sprite is
// configured/loaded) AND the local-player glow ring (drawn around whichever
// one actually renders, sprite included) — kept proportional to TILE_SIZE so
// the glow doesn't end up a fixed 32px-era size wrapped around a now-larger
// 48px sprite. 14/32 preserves the original 32px-tile-era ratio exactly.
const AVATAR_RADIUS = TILE_SIZE * (14 / 32);

const DEFAULT_COLOR = '#ff6b6b';

// Raised-hand badge — same custom icon HandButton.tsx/VideoGrid.tsx/
// ParticipantPanel.tsx use now (was a plain ✋ fillText emoji, inconsistent
// once those switched). Loaded once at module scope, drawn via drawImage
// instead of fillText — `.complete`/`naturalWidth` guard the brief window
// before it's decoded so an early frame just skips drawing it rather than
// throwing or painting a broken image.
const handRaiseIcon = new Image();
handRaiseIcon.src = '/assets/img/raise-hand-icon.png';

interface DrawAvatarOptions {
  avatar: Avatar;
  x: number;
  y: number;
  isLocal: boolean;
  walkAnimOffset: number;
  // Raw rAF timestamp, used to drive sprite frame cycling. Optional so
  // existing call sites (e.g. the avatar editor preview) keep working.
  timestamp?: number;
  // Room-wide size multiplier (see gameStore.ts's avatarScale) — defaults to
  // 1 so every existing call site (avatar editor preview, etc.) is
  // unaffected. Scales both the shape-fallback body/glow AND the pixel-art
  // sprite; badges/labels above the head are positioned relative to `r`
  // below, so they naturally follow the character outward as it grows.
  scale?: number;
  // "Ngobrol dengan CEO" queue countdown, e.g. "⏳ 4:32" — pre-formatted by
  // the caller (GameCanvas.tsx, ticking every frame off activeZoneSessions'
  // endsAt) since this module has no timer/clock access of its own. Shown
  // for BOTH sides of an active session: the visitor and whoever they're
  // visiting (e.g. the CEO), from every other player's point of view too.
  queueCountdown?: string;
}

// Returns the Y position immediately above everything this function drew
// (name label, statusTag, presence pill — however many of those three are
// actually present for this avatar right now) — the next free vertical
// slot, so a caller stacking something else above the head (GameCanvas.tsx's
// admin crown/soundboard icon) lands there instead of a hardcoded offset
// that collides whenever a status badge happens to already occupy that
// exact spot (see GameCanvas.tsx's own call site for the bug this fixed).
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  options: DrawAvatarOptions,
): number {
  const { avatar, x, y, isLocal, walkAnimOffset, timestamp = 0, scale = 1, queueCountdown } = options;
  const config = avatar.avatarConfig;
  const color = config?.color || avatar.color || DEFAULT_COLOR;
  const accessory = config?.accessory || 'none';
  const expression = config?.expression || 'neutral';
  const name = avatar.name;

  const cx = x;
  const cy = y + walkAnimOffset;
  const r = AVATAR_RADIUS * scale;

  ctx.save();

  // ─── Glow ring for local player ──────────────────────────────
  if (isLocal) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ─── Pixel-art sprite (falls back to shape below if the sprite images
  // haven't finished loading yet, or none is configured) ──────────────
  const spriteSize = (avatar.isSitting ? TILE_SIZE : SPRITE_DISPLAY_SIZE) * scale;

  let renderedSprite = false;
  if (config?.spriteMode === 'premade' && config.premadeId) {
    renderedSprite = drawPremadeAvatar(ctx, cx, cy, config.premadeId, avatar.direction, avatar.isMoving, timestamp, !!avatar.isRunning, spriteSize, !!avatar.isSitting);
  } else if (config?.spriteMode === 'layered' && config.bodyId) {
    renderedSprite = drawLayeredAvatar(ctx, cx, cy, config, avatar.direction, avatar.isMoving, timestamp, !!avatar.isRunning, spriteSize, !!avatar.isSitting);
  }

  if (!renderedSprite) {
    const bodyShape = config?.bodyShape || 'circle';

    // ─── Body shape ─────────────────────────────────────────────
    drawBodyShape(ctx, cx, cy, r, bodyShape, color);

    // ─── Direction indicator ────────────────────────────────────
    drawDirectionIndicator(ctx, cx, cy, r, avatar.direction);

    // ─── Expression (eyes + mouth) ──────────────────────────────
    drawExpression(ctx, cx, cy, r, expression);

    // ─── Accessory ──────────────────────────────────────────────
    if (accessory !== 'none') {
      drawAccessory(ctx, cx, cy, r, accessory, color);
    }
  }

  ctx.restore();

  // ─── Name label above avatar ────────────────────────────────
  // ZEP-style Spotlight — prefixed straight onto the name string (rather
  // than a separate badge) so drawNameLabel's existing width-measurement/
  // pill-sizing logic doesn't need touching; reaches everyone in the room
  // regardless of distance, so this is the one glanceable "why can I hear
  // them from all the way over here" cue.
  const displayName = avatar.spotlightActive ? `📢 ${name}` : name;
  drawNameLabel(ctx, cx, cy - r - 9, displayName, isLocal);

  // ─── Status badge below name ────────────────────────────────
  let nextBadgeY = cy - r - 23;
  if (config?.statusTag) {
    drawStatusTag(ctx, cx, nextBadgeY, config.statusTag);
    nextBadgeY -= 14;
  }

  // ─── Single unified status pill ─────────────────────────────────────
  // The effective work-mode/presence status, shown as one glanceable pill
  // above the avatar. Bug fix — this used to be a hand-written ternary
  // chain covering only the original 6 statuses (wfh/in_meeting/focus/
  // lunch/break/away); wfo/wfa/cuti (QA #1) were added to WorkMode and the
  // STATUS dropdown but never to this chain, so picking any of those three
  // silently showed no pill at all. Now reads PRESENCE_LABEL/PRESENCE_EMOJI
  // (data/presence.ts) — the same shared map the HUD dropdown and
  // Participant panel already use — so a future status added there can't
  // drift out of sync with this pill again. 'available' still shows no
  // pill (PRESENCE_EMOJI has no entry for it — a plain online dot instead,
  // unchanged from before).
  const presenceLabel = avatar.workMode && avatar.workMode !== 'available'
    ? `${PRESENCE_EMOJI[avatar.workMode]} ${PRESENCE_LABEL[avatar.workMode]}`
    : '';
  if (presenceLabel) {
    drawPresencePill(ctx, cx, nextBadgeY, presenceLabel);
    nextBadgeY -= 15;
  }

  // ─── Raised hand — the top-most cue, gently waving so it reads as an
  // active "I want to speak" signal rather than a static icon. ──────────
  if (avatar.handRaised) {
    const wave = Math.sin(timestamp * 0.008) * 0.25;
    ctx.save();
    ctx.translate(cx, nextBadgeY - 4);
    ctx.rotate(wave);
    if (handRaiseIcon.complete && handRaiseIcon.naturalWidth > 0) {
      ctx.drawImage(handRaiseIcon, -9, -8, 18, 16);
    }
    ctx.restore();
  }

  // ─── "Ngobrol dengan CEO" queue countdown — topmost, since it's the
  // most time-sensitive cue on screen for both the visitor and whoever
  // they're visiting (e.g. the CEO). ──────────────────────────────────
  if (queueCountdown) {
    drawQueueCountdownPill(ctx, cx, nextBadgeY, queueCountdown);
  }

  // Hand-raise and the queue countdown intentionally share the same slot
  // above (both "topmost", see their own comments) rather than stacking on
  // each other — so this only needs to clear that ONE shared slot once,
  // not twice, when accounting for whichever (if either) was actually drawn.
  if (avatar.handRaised || queueCountdown) nextBadgeY -= 20;
  return nextBadgeY;
}

// ─── Layered pixel-art sprite ──────────────────────────────────────
//
// Assets come from the LimeZu "Character Generator" pack
// (client/public/assets/characters/generator/<Category>/*.png). Every file
// in a category shares one 56x41-cell grid of 32x32 frames:
//   - row 3  = idle animation, row 5 = walk animation, 24 cols wide each
//   - the 24 cols split into 4 direction-groups of 6 frames. The asset
//     pack's own docs (Spritesheet_animations_GUIDE.png, ASSETS_README.md)
//     say the column order is down/left/right/up, but that turned out to be
//     one rotation off from how these particular frames actually look in
//     game — confirmed by having each direction key show the previous
//     key's pose (W showed A's pose, A showed D's, D showed S's, S showed
//     W's). Rotating the mapping by one step fixes it; if the asset files
//     ever get regenerated/replaced, re-verify this in-browser rather than
//     trusting the docs literally.
const GENERATOR_BASE = '/assets/characters/generator';
// generator-premade characters are ready-made exports from the same
// Character Generator tool, so they share the identical 56x41 frame grid
// (verified: 1792x1312px, same as every generator/<Category> file).
const PREMADE_BASE = '/assets/characters/premade/generator-premade';
const FRAME_SIZE = 32;
// The generator packs its 6-frame animation strips two nominal 32px rows to
// a character: the character's own art is 44px tall (not 32), stored
// starting 20px into the FIRST of its two rows and continuing through all
// of the second — e.g. row 3 (IDLE_ROW) is really "half of row 2 + all of
// row 3". Verified by scanning Body_32x32_01.png/Outfit_01_32x32_01.png/a
// premade sheet's alpha channel directly: every populated row pair starts
// at local-y=20 and runs 44px, never just 32. Cropping the naive 32x32 cell
// (what this code did before) grabs only the BOTTOM 32 of those 44 pixels —
// exactly the neck-down portion — silently decapitating every sprite.
const FRAME_VISUAL_HEIGHT = 44;
const FRAME_ROW_Y_OFFSET = 20;
const FRAMES_PER_DIRECTION = 6;
// On-screen size a standing/walking avatar is drawn at — tracks TILE_SIZE
// (the logical/display grid unit, see its own doc comment) so the character
// scales up right along with the tile grid; FRAME_SIZE above stays fixed at
// 32 regardless, since that's the actual source art's pixel grid, not a
// display size.
const SPRITE_DISPLAY_SIZE = TILE_SIZE;
const IDLE_ROW = 3;
const WALK_ROW = 5;
// "Sit" pose (see the pack's own Spritesheet_animations_GUIDE.png) — a real
// bent-knee seated pose, distinct from idle, used so a seated avatar
// (Avatar.isSitting) doesn't just look like it's standing at the chair.
// Only drawn for the 'right' and 'up' facing columns in this asset pack —
// 'left'/'down' are blank frames there. 'left' is approximated by
// horizontally mirroring 'right' (idle/walk frames in this same pack are
// already left-right symmetric, so the mirror reads correctly — see
// spriteFrameCoords' flipX). 'down' has no equivalent art at all and falls
// back to the ordinary idle pose: a real but partial improvement over every
// direction silently reusing idle, which was the previous behavior.
const SIT_ROW = 9;
const IDLE_FRAME_MS = 400;
// Both divided by the same 1.2 PLAYER_SPEED/PLAYER_RUN_SPEED were just
// bumped by (110/1.2, 70/1.2, rounded) — a shorter frame duration cycles the
// walk animation faster, keeping stride length on-screen the same as before
// the speed bump instead of the avatar visibly sliding faster than its legs
// animate.
const WALK_FRAME_MS = 92;
// Run reuses the walk row (no dedicated run frames in this asset pack — see
// PLAYER_RUN_SPEED's doc comment in shared/types/index.ts) at a faster cycle
// so the legs visibly move quicker in step with the higher actual speed.
const RUN_FRAME_MS = 58;

const DIRECTION_COLUMN_ORDER: Direction[] = ['right', 'up', 'left', 'down'];

const LAYER_CATEGORIES: Array<[string, keyof NonNullable<Avatar['avatarConfig']>]> = [
  ['Bodies', 'bodyId'],
  ['Eyes', 'eyesId'],
  ['Outfits', 'outfitId'],
  ['Hairstyles', 'hairId'],
  ['Accessories', 'spriteAccessoryId'],
];

function spriteFrameCoords(direction: Direction, isMoving: boolean, timestamp: number, isRunning: boolean, isSitting: boolean) {
  if (isSitting && direction !== 'down') {
    // 'left' borrows 'right''s frames, mirrored (flipX) — see SIT_ROW's doc comment.
    const sitDirection = direction === 'left' ? 'right' : direction;
    const dirIndex = DIRECTION_COLUMN_ORDER.indexOf(sitDirection);
    const frameInCycle = Math.floor(timestamp / IDLE_FRAME_MS) % FRAMES_PER_DIRECTION;
    const col = dirIndex * FRAMES_PER_DIRECTION + frameInCycle;
    return { col, row: SIT_ROW, flipX: direction === 'left' };
  }
  const dirIndex = Math.max(0, DIRECTION_COLUMN_ORDER.indexOf(direction));
  // Sitting facing 'down' falls through to here (no sit art for that
  // direction — see SIT_ROW). It must still never play a walk cycle: a
  // seated avatar showing a run animation is how a stuck isMoving flag used
  // to surface, and reading "someone jogging in their chair" as a rendering
  // bug is exactly what happened. The flag itself is fixed elsewhere
  // (movementHandler.ts's activeMovers sweep); this makes the pose
  // impossible to draw regardless of what the flag says.
  const animating = isMoving && !isSitting;
  const row = animating ? WALK_ROW : IDLE_ROW;
  const frameMs = animating ? (isRunning ? RUN_FRAME_MS : WALK_FRAME_MS) : IDLE_FRAME_MS;
  const frameInCycle = Math.floor(timestamp / frameMs) % FRAMES_PER_DIRECTION;
  const col = dirIndex * FRAMES_PER_DIRECTION + frameInCycle;
  return { col, row, flipX: false };
}

// Composed avatar frames, cached.
//
// A generator avatar is built from one sprite per layer — body, outfit, hair,
// accessory and so on — each from its OWN spritesheet file. Drawing it meant a
// drawImage per layer per avatar per frame: with eighteen people on screen that
// is a hundred-odd draws touching a handful of large, distinct textures, sixty
// times a second.
//
// Measured, that pass averaged 25ms per frame, and it spiked in lockstep with
// the floor-plan reference image — the tell for texture-cache thrashing rather
// than pixel work (frame times were bimodal, p50 2.7ms / p95 250ms: some frames
// found every sheet resident, others re-uploaded them).
//
// So compose once and blit thereafter. The cache key is the whole visual
// identity of the frame — every layer filename, the source cell (which encodes
// direction and animation frame) and the raster size — so a hit is
// pixel-identical to composing again. Eighteen players share very few distinct
// keys: a handful of outfits x four directions x a few walk frames.
// Sized against the actual working set, which is arithmetic rather than a
// guess: FRAMES_PER_DIRECTION (6) x four directions x three rows (idle, walk,
// sit) is 72 distinct frames per outfit, so eighteen people in differing
// outfits reach ~1300 live entries. The first version of this capped at 240 —
// five times too small — and a cache smaller than its working set does not
// merely fail to help, it HURTS: FIFO eviction throws entries out before they
// are reused, so avatars are re-composited continuously and every re-composite
// touches all the layer spritesheets again. That is the episodic spike this was
// supposed to remove (frames clustered at 200-290ms while several people walked
// in different directions), caused by the cure rather than the disease.
const LAYERED_AVATAR_CACHE_LIMIT = 2000;
// And a second bound, because entry COUNT is not what costs memory: an entry is
// rasterW x rasterH pixels, which grows with zoom and dpr. ~8M pixels is about
// 32MB of canvas — at the common 48x66 frame that is ~2500 entries, and at 2x
// zoom on a 2x display it falls to ~600, which is the correct direction for it
// to move on its own.
const LAYERED_AVATAR_CACHE_PIXEL_BUDGET = 8_000_000;
const layeredSpriteCache = new Map<string, HTMLCanvasElement>();
let layeredSpriteCachePixels = 0;

function layeredAvatarCacheKey(
  config: NonNullable<Avatar['avatarConfig']>,
  srcX: number,
  srcY: number,
  rasterW: number,
  rasterH: number,
): string {
  let key = `${srcX},${srcY},${rasterW}x${rasterH}`;
  for (const [, field] of LAYER_CATEGORIES) key += `|${(config[field] as string | undefined) ?? ''}`;
  return key;
}

/** One composed frame, from cache when possible. Null while its layers are
 *  still loading, so the caller can report "nothing drawn" and try again. */
function composedLayeredFrame(
  config: NonNullable<Avatar['avatarConfig']>,
  srcX: number,
  srcY: number,
  rasterW: number,
  rasterH: number,
): HTMLCanvasElement | null {
  const key = layeredAvatarCacheKey(config, srcX, srcY, rasterW, rasterH);
  const hit = layeredSpriteCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = rasterW;
  canvas.height = rasterH;
  const cctx = canvas.getContext('2d');
  if (!cctx) return null;
  cctx.imageSmoothingEnabled = false;

  let expected = 0;
  let drawn = 0;
  for (const [category, field] of LAYER_CATEGORIES) {
    const fileName = config[field] as string | undefined;
    if (!fileName) continue;
    expected++;
    if (drawSpriteFrame(cctx, `${GENERATOR_BASE}/${category}/${fileName}`, {
      srcX, srcY, cellWidth: FRAME_SIZE, cellHeight: FRAME_VISUAL_HEIGHT,
      dx: 0, dy: 0, dWidth: rasterW, dHeight: rasterH,
    })) drawn++;
  }
  if (!drawn) return null;

  // Only cache a COMPLETE composite. A frame missing a layer whose sheet has
  // not decoded yet would otherwise be cached with that layer permanently
  // absent — an avatar with no hair for the rest of the session.
  if (drawn === expected) {
    layeredSpriteCache.set(key, canvas);
    layeredSpriteCachePixels += rasterW * rasterH;
    // Evict oldest-first until BOTH bounds hold. Map iteration order is
    // insertion order, so this is FIFO — good enough here, because the working
    // set is now expected to fit and eviction should be the exception rather
    // than the steady state.
    while (
      layeredSpriteCache.size > LAYERED_AVATAR_CACHE_LIMIT ||
      layeredSpriteCachePixels > LAYERED_AVATAR_CACHE_PIXEL_BUDGET
    ) {
      const oldestKey = layeredSpriteCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = layeredSpriteCache.get(oldestKey);
      layeredSpriteCache.delete(oldestKey);
      if (evicted) layeredSpriteCachePixels -= evicted.width * evicted.height;
      if (oldestKey === key) break; // never evict what we just inserted
    }
  }
  return canvas;
}

function drawLayeredAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  config: NonNullable<Avatar['avatarConfig']>,
  direction: Direction,
  isMoving: boolean,
  timestamp: number,
  isRunning: boolean,
  displaySize: number = SPRITE_DISPLAY_SIZE,
  isSitting: boolean = false,
): boolean {
  const { col, row, flipX } = spriteFrameCoords(direction, isMoving, timestamp, isRunning, isSitting);
  const displayHeight = displaySize * (FRAME_VISUAL_HEIGHT / FRAME_SIZE);
  // Round to a whole pixel — the player's world position moves in
  // continuous float steps (PLAYER_SPEED * dt), so cx/cy are almost never
  // integers. With imageSmoothingEnabled off, drawImage() at a fractional
  // destination forces nearest-neighbor to duplicate/skip source pixel
  // rows and columns unevenly to fill the sub-pixel-offset target — most
  // visible on the head (dense detail: eyes, hairline) versus the outfit's
  // flat color blocks, which reads exactly like "the head is glitched/torn"
  // even though every layer is otherwise correctly aligned.
  const dx = Math.round(cx - displaySize / 2);
  // Bottom-anchored, not centered — the extra height (see FRAME_VISUAL_HEIGHT)
  // is headroom added ABOVE the character, so the feet stay planted on the
  // tile instead of the whole sprite shifting down as it grows taller.
  const dy = Math.round(cy + displaySize / 2 - displayHeight);
  const srcX = col * FRAME_SIZE;
  const srcY = (row - 1) * FRAME_SIZE + FRAME_ROW_Y_OFFSET;

  // 'left'-facing sit mirrors the 'right' pose (see SIT_ROW's doc comment) —
  // flip around the sprite's own horizontal center, not the canvas origin,
  // so the mirrored frame lands in the exact same screen spot. Pivots on
  // dx's own rounded center (dx + displaySize/2), NOT the raw unrounded cx
  // — cx is a continuous float (player position), so using it directly
  // here reintroduced a sub-pixel offset on top of dx's already-rounded
  // value, undoing the whole-pixel alignment dx was computed for in the
  // first place (only visible on the sit+face-left pose).
  if (flipX) { const pivotX = dx + displaySize / 2; ctx.save(); ctx.translate(pivotX, 0); ctx.scale(-1, 1); ctx.translate(-pivotX, 0); }

  // Composed at the RASTER size the destination will occupy, so the blit is
  // 1:1 and pixel art stays as crisp as drawing each layer directly did. The
  // transform already carries zoom x dpr; reading it is what keeps the cache
  // key honest about size.
  const rasterScale = typeof ctx.getTransform === 'function' ? Math.abs(ctx.getTransform().a) || 1 : 1;
  const rasterW = Math.max(1, Math.round(displaySize * rasterScale));
  const rasterH = Math.max(1, Math.round(displayHeight * rasterScale));
  const cached = composedLayeredFrame(config, srcX, srcY, rasterW, rasterH);
  if (cached) ctx.drawImage(cached, 0, 0, cached.width, cached.height, dx, dy, displaySize, displayHeight);
  if (flipX) ctx.restore();
  return !!cached;
}

function drawPremadeAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  premadeId: string,
  direction: Direction,
  isMoving: boolean,
  timestamp: number,
  isRunning: boolean,
  displaySize: number = SPRITE_DISPLAY_SIZE,
  isSitting: boolean = false,
): boolean {
  const { col, row, flipX } = spriteFrameCoords(direction, isMoving, timestamp, isRunning, isSitting);
  const displayHeight = displaySize * (FRAME_VISUAL_HEIGHT / FRAME_SIZE);
  const dx = Math.round(cx - displaySize / 2);
  const dy = Math.round(cy + displaySize / 2 - displayHeight);
  const srcX = col * FRAME_SIZE;
  const srcY = (row - 1) * FRAME_SIZE + FRAME_ROW_Y_OFFSET;

  if (flipX) { ctx.save(); ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0); }
  const drew = drawSpriteFrame(ctx, `${PREMADE_BASE}/${premadeId}`, {
    srcX, srcY, cellWidth: FRAME_SIZE, cellHeight: FRAME_VISUAL_HEIGHT,
    dx, dy, dWidth: displaySize, dHeight: displayHeight,
  });
  if (flipX) ctx.restore();
  return drew;
}

// ─── Body shapes ──────────────────────────────────────────────────

function drawBodyShape(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  shape: BodyShape,
  color: string,
) {
  ctx.beginPath();

  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;

    case 'rounded-square':
      ctx.moveTo(cx - r, cy - r + 4);
      ctx.quadraticCurveTo(cx - r, cy - r, cx - r + 4, cy - r);
      ctx.lineTo(cx + r - 4, cy - r);
      ctx.quadraticCurveTo(cx + r, cy - r, cx + r, cy - r + 4);
      ctx.lineTo(cx + r, cy + r - 4);
      ctx.quadraticCurveTo(cx + r, cy + r, cx + r - 4, cy + r);
      ctx.lineTo(cx - r + 4, cy + r);
      ctx.quadraticCurveTo(cx - r, cy + r, cx - r, cy + r - 4);
      ctx.closePath();
      break;

    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const hx = cx + r * Math.cos(angle);
        const hy = cy + r * Math.sin(angle);
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      break;
  }

  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ─── Direction indicator ──────────────────────────────────────────

function drawDirectionIndicator(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  direction: Direction,
) {
  let tipX = cx, tipY = cy;
  const tipDist = r * 0.55;

  switch (direction) {
    case 'up': tipY = cy - tipDist; break;
    case 'down': tipY = cy + tipDist; break;
    case 'left': tipX = cx - tipDist; break;
    case 'right': tipX = cx + tipDist; break;
  }

  const size = 4;
  const angle = direction === 'up' ? -Math.PI / 2
    : direction === 'down' ? Math.PI / 2
    : direction === 'left' ? Math.PI
    : 0;

  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size, size);
  ctx.lineTo(-size, size);
  ctx.closePath();

  // Slightly darker when facing away (up)
  const isFacingAway = direction === 'up';
  ctx.fillStyle = isFacingAway ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.85)';
  ctx.fill();

  ctx.restore();
}

// ─── Expressions ──────────────────────────────────────────────────

function drawExpression(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  expression: Expression,
) {
  switch (expression) {
    case 'neutral':
      drawNeutral(ctx, cx, cy, r);
      break;
    case 'happy':
      drawHappy(ctx, cx, cy, r);
      break;
    case 'cool':
      drawCool(ctx, cx, cy, r);
      break;
    case 'thinking':
      drawThinking(ctx, cx, cy, r);
      break;
    case 'sleepy':
      drawSleepy(ctx, cx, cy, r);
      break;
  }
}

function drawNeutral(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const eyeOffX = r * 0.35;
  const eyeY = cy - r * 0.15;
  // Eyes
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.arc(cx - eyeOffX, eyeY, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + eyeOffX, eyeY, 1.8, 0, Math.PI * 2); ctx.fill();
  // Mouth
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.25, cy + r * 0.25);
  ctx.lineTo(cx + r * 0.25, cy + r * 0.25);
  ctx.stroke();
}

function drawHappy(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const eyeOffX = r * 0.33;
  const eyeY = cy - r * 0.15;
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.arc(cx - eyeOffX, eyeY, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + eyeOffX, eyeY, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.15, r * 0.2, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

function drawCool(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.fillStyle = '#1a1a1a';
  // Shades
  ctx.fillRect(cx - r * 0.45, cy - r * 0.2, r * 0.33, 3.5);
  ctx.fillRect(cx + r * 0.12, cy - r * 0.2, r * 0.33, 3.5);
  // Bridge
  ctx.fillRect(cx - r * 0.12, cy - r * 0.22, r * 0.24, 2);
  // Smirk
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.1, cy + r * 0.25);
  ctx.quadraticCurveTo(cx + r * 0.25, cy + r * 0.15, cx + r * 0.35, cy + r * 0.25);
  ctx.stroke();
}

function drawThinking(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const eyeOffX = r * 0.35;
  const eyeY = cy - r * 0.15;
  // Left eye — normal
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.arc(cx - eyeOffX, eyeY, 1.8, 0, Math.PI * 2); ctx.fill();
  // Right eye — raised eyebrow
  ctx.beginPath(); ctx.arc(cx + eyeOffX, eyeY - 1.5, 1.8, 0, Math.PI * 2); ctx.fill();
  // Raised eyebrow stroke
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx + eyeOffX - 4, eyeY - 1.5 - 3);
  ctx.lineTo(cx + eyeOffX + 4, eyeY - 1.5 - 3);
  ctx.stroke();
  // Mouth — squiggly
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.2, cy + r * 0.28);
  ctx.quadraticCurveTo(cx - r * 0.1, cy + r * 0.15, cx, cy + r * 0.25);
  ctx.quadraticCurveTo(cx + r * 0.1, cy + r * 0.35, cx + r * 0.2, cy + r * 0.2);
  ctx.stroke();
}

function drawSleepy(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const eyeOffX = r * 0.35;
  const eyeY = cy - r * 0.1;
  // Closed eyes (horizontal lines)
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - eyeOffX - 3, eyeY);
  ctx.lineTo(cx - eyeOffX + 3, eyeY);
  ctx.moveTo(cx + eyeOffX - 3, eyeY);
  ctx.lineTo(cx + eyeOffX + 3, eyeY);
  ctx.stroke();
  // ZZZ
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '6px sans-serif';
  ctx.fillText('z', cx + r * 0.4, cy - r * 0.4);
  ctx.font = '7px sans-serif';
  ctx.fillText('z', cx + r * 0.65, cy - r * 0.7);
  ctx.font = '8px sans-serif';
  ctx.fillText('z', cx + r * 0.9, cy - r * 1.0);
  // Mouth — small O
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.3, 2.5, 0, Math.PI * 2);
  ctx.stroke();
}

// ─── Accessories ──────────────────────────────────────────────────

function drawAccessory(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  type: Accessory,
  color: string,
) {
  switch (type) {
    case 'cap':
      drawCap(ctx, cx, cy, r, color);
      break;
    case 'crown':
      drawCrown(ctx, cx, cy, r);
      break;
    case 'headphones':
      drawHeadphones(ctx, cx, cy, r);
      break;
    case 'halo':
      drawHalo(ctx, cx, cy, r);
      break;
    case 'bow':
      drawBow(ctx, cx, cy, r, color);
      break;
  }
}

function drawCap(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  const y = cy - r - 1;
  // Brim
  ctx.fillStyle = darken(color, 0.3);
  ctx.fillRect(cx - r * 0.9, y - 1, r * 1.8, 4);
  // Dome
  ctx.beginPath();
  ctx.arc(cx, y, r * 0.7, Math.PI, 0);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = darken(color, 0.4);
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const y = cy - r;
  const h = r * 0.5;
  const half = r * 0.55;
  ctx.beginPath();
  ctx.moveTo(cx - half, y + 2);
  ctx.lineTo(cx - half, y - h);
  ctx.lineTo(cx - half * 0.4, y - h * 0.3);
  ctx.lineTo(cx, y - h * 0.9);
  ctx.lineTo(cx + half * 0.4, y - h * 0.3);
  ctx.lineTo(cx + half, y - h);
  ctx.lineTo(cx + half, y + 2);
  ctx.closePath();
  ctx.fillStyle = '#F0C040';
  ctx.fill();
  ctx.strokeStyle = '#B89020';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Gems
  ctx.fillStyle = '#FF3030';
  ctx.beginPath(); ctx.arc(cx - half * 0.7, y - h * 0.5, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, y - h * 0.7, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + half * 0.7, y - h * 0.5, 2, 0, Math.PI * 2); ctx.fill();
}

function drawHeadphones(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const earY = cy - r * 0.2;
  const earX = r * 1.05;
  // Arc over top
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, Math.PI, 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Ear cups
  ctx.fillStyle = '#444';
  ctx.beginPath(); ctx.arc(cx - earX, earY, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + earX, earY, 4, 0, Math.PI * 2); ctx.fill();
  // Connectors
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx - earX + 4, earY);
  ctx.moveTo(cx + r, cy);
  ctx.lineTo(cx + earX - 4, earY);
  ctx.stroke();
}

function drawHalo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const haloY = cy - r - 2;
  ctx.beginPath();
  ctx.ellipse(cx, haloY, r * 0.6, 4, 0, 0, Math.PI * 2);
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)';
  ctx.lineWidth = 4;
  ctx.stroke();
}

function drawBow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  const y = cy - r;
  const bowColor = brighten(color, 0.3);
  // Left triangle
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.lineTo(cx - r * 0.4, y - 5);
  ctx.lineTo(cx - r * 0.4, y + 3);
  ctx.closePath();
  ctx.fillStyle = bowColor;
  ctx.fill();
  // Right triangle
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.lineTo(cx + r * 0.4, y - 5);
  ctx.lineTo(cx + r * 0.4, y + 3);
  ctx.closePath();
  ctx.fill();
  // Center knot
  ctx.beginPath();
  ctx.arc(cx, y, 2, 0, Math.PI * 2);
  ctx.fillStyle = darken(bowColor, 0.2);
  ctx.fill();
}

// ─── Labels ───────────────────────────────────────────────────────

const NAME_LABEL_MAX_CHARS = 14;

function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  name: string,
  isLocal: boolean,
) {
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const displayName = truncateName(name, NAME_LABEL_MAX_CHARS);
  const tw = measureTextCached(ctx, displayName);
  const th = 14;
  const padX = 5;
  const padY = 2;

  // Background pill
  const bgX = x - tw / 2 - padX;
  const bgY = baseY - th + padY;
  const bgW = tw + padX * 2;
  const bgH = th;

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  roundRect(ctx, bgX, bgY, bgW, bgH, 6);
  ctx.fill();

  // Text
  ctx.fillStyle = isLocal ? '#ffdd57' : '#ffffff';
  ctx.fillText(displayName, x, baseY);
}

function drawStatusTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  tag: string,
) {
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const tw = measureTextCached(ctx, tag);
  const padX = 4;
  const padY = 1;
  const h = 12;

  const bgX = x - tw / 2 - padX;
  const bgY = baseY - h + padY;
  const bgW = tw + padX * 2;

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  roundRect(ctx, bgX, bgY, bgW, h, 4);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(tag, x, baseY);
}

// Presence status label (WFH/In Meeting/Focus/Lunch/Break/Away) — solid
// purple pill, more prominent than the subtle avatarConfig.statusTag above,
// since it's meant to be glanceable across the room.
function drawPresencePill(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  status: string,
) {
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const tw = measureTextCached(ctx, status);
  const padX = 5;
  const padY = 1;
  const h = 13;

  const bgX = x - tw / 2 - padX;
  const bgY = baseY - h + padY;
  const bgW = tw + padX * 2;

  ctx.fillStyle = '#7c3aed';
  ctx.beginPath();
  roundRect(ctx, bgX, bgY, bgW, h, 5);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(status, x, baseY);
}

// "Ngobrol dengan CEO" queue countdown — amber pill so it reads distinctly
// from the purple presence pill above, drawn over BOTH avatars in an
// active session (the visitor and whoever they're visiting) for everyone
// in the room, not just the two of them.
function drawQueueCountdownPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  label: string,
) {
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const tw = measureTextCached(ctx, label);
  const padX = 5;
  const padY = 1;
  const h = 13;

  const bgX = x - tw / 2 - padX;
  const bgY = baseY - h + padY;
  const bgW = tw + padX * 2;

  ctx.fillStyle = '#d97706';
  ctx.beginPath();
  roundRect(ctx, bgX, bgY, bgW, h, 5);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, baseY);
}

// ─── Color helpers ────────────────────────────────────────────────

function darken(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) * (1 - amount));
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) * (1 - amount));
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) * (1 - amount));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function brighten(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) * (1 + amount));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) * (1 + amount));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) * (1 + amount));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

// ─── Utility ──────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export { darken, brighten };
