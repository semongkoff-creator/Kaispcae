import { Avatar, BodyShape, Accessory, Expression, Direction } from '@virtualmeet/shared';
import { drawSpriteFrame } from '@/utils/spriteLoader';

const AVATAR_RADIUS = 14;
const GLOW_RADIUS = AVATAR_RADIUS + 4;

const DEFAULT_COLOR = '#ff6b6b';

interface DrawAvatarOptions {
  avatar: Avatar;
  x: number;
  y: number;
  isLocal: boolean;
  walkAnimOffset: number;
  // Raw rAF timestamp, used to drive sprite frame cycling. Optional so
  // existing call sites (e.g. the avatar editor preview) keep working.
  timestamp?: number;
}

export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  options: DrawAvatarOptions,
) {
  const { avatar, x, y, isLocal, walkAnimOffset, timestamp = 0 } = options;
  const config = avatar.avatarConfig;
  const color = config?.color || avatar.color || DEFAULT_COLOR;
  const accessory = config?.accessory || 'none';
  const expression = config?.expression || 'neutral';
  const name = avatar.name;

  const cx = x;
  const cy = y + walkAnimOffset;
  const r = AVATAR_RADIUS;

  ctx.save();

  // ─── Glow ring for local player ──────────────────────────────
  if (isLocal) {
    ctx.beginPath();
    ctx.arc(cx, cy, GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, GLOW_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ─── Pixel-art sprite (falls back to shape below if the sprite images
  // haven't finished loading yet, or none is configured) ──────────────
  let renderedSprite = false;
  if (config?.spriteMode === 'premade' && config.premadeId) {
    renderedSprite = drawPremadeAvatar(ctx, cx, cy, config.premadeId, avatar.direction, avatar.isMoving, timestamp);
  } else if (config?.spriteMode === 'layered' && config.bodyId) {
    renderedSprite = drawLayeredAvatar(ctx, cx, cy, config, avatar.direction, avatar.isMoving, timestamp);
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
  drawNameLabel(ctx, cx, cy - r - 9, name, isLocal);

  // ─── Status badge below name ────────────────────────────────
  if (config?.statusTag) {
    drawStatusTag(ctx, cx, cy - r - 23, config.statusTag);
  }
}

// ─── Layered pixel-art sprite ──────────────────────────────────────
//
// Assets come from the LimeZu "Character Generator" pack
// (client/public/assets/characters/generator/<Category>/*.png). Every file
// in a category shares one 56x41-cell grid of 32x32 frames. Layout isn't
// documented anywhere machine-readable, so this was reverse-engineered by
// inspecting pixel occupancy per cell against Spritesheet_animations_GUIDE.png:
//   - row 3  = idle animation, row 5 = walk animation, 24 cols wide each
//   - the 24 cols split into 4 direction-groups of 6 frames; the group at
//     columns 6-11 is the only one where the Eyes layer is fully blank in
//     every frame, which only makes sense for the "facing away" pose — so
//     direction order is down, up, left, right (not the more common
//     down/left/right/up ordering).
// If this ever looks wrong in-browser, adjust DIRECTION_COLUMN_ORDER below.
const GENERATOR_BASE = '/assets/characters/generator';
// generator-premade characters are ready-made exports from the same
// Character Generator tool, so they share the identical 56x41 frame grid
// (verified: 1792x1312px, same as every generator/<Category> file).
const PREMADE_BASE = '/assets/characters/premade/generator-premade';
const FRAME_SIZE = 32;
const FRAMES_PER_DIRECTION = 6;
const SPRITE_DISPLAY_SIZE = 40;
const IDLE_ROW = 3;
const WALK_ROW = 5;
const IDLE_FRAME_MS = 400;
const WALK_FRAME_MS = 110;

const DIRECTION_COLUMN_ORDER: Direction[] = ['down', 'up', 'left', 'right'];

const LAYER_CATEGORIES: Array<[string, keyof NonNullable<Avatar['avatarConfig']>]> = [
  ['Bodies', 'bodyId'],
  ['Eyes', 'eyesId'],
  ['Outfits', 'outfitId'],
  ['Hairstyles', 'hairId'],
  ['Accessories', 'spriteAccessoryId'],
];

function spriteFrameCoords(direction: Direction, isMoving: boolean, timestamp: number) {
  const dirIndex = Math.max(0, DIRECTION_COLUMN_ORDER.indexOf(direction));
  const row = isMoving ? WALK_ROW : IDLE_ROW;
  const frameMs = isMoving ? WALK_FRAME_MS : IDLE_FRAME_MS;
  const frameInCycle = Math.floor(timestamp / frameMs) % FRAMES_PER_DIRECTION;
  const col = dirIndex * FRAMES_PER_DIRECTION + frameInCycle;
  return { col, row };
}

function drawLayeredAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  config: NonNullable<Avatar['avatarConfig']>,
  direction: Direction,
  isMoving: boolean,
  timestamp: number,
): boolean {
  const { col, row } = spriteFrameCoords(direction, isMoving, timestamp);
  const dx = cx - SPRITE_DISPLAY_SIZE / 2;
  const dy = cy - SPRITE_DISPLAY_SIZE / 2;

  let drewAny = false;
  for (const [category, field] of LAYER_CATEGORIES) {
    const fileName = config[field] as string | undefined;
    if (!fileName) continue;
    const drew = drawSpriteFrame(ctx, `${GENERATOR_BASE}/${category}/${fileName}`, {
      col, row, cellWidth: FRAME_SIZE, cellHeight: FRAME_SIZE,
      dx, dy, dWidth: SPRITE_DISPLAY_SIZE, dHeight: SPRITE_DISPLAY_SIZE,
    });
    drewAny = drewAny || drew;
  }
  return drewAny;
}

function drawPremadeAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  premadeId: string,
  direction: Direction,
  isMoving: boolean,
  timestamp: number,
): boolean {
  const { col, row } = spriteFrameCoords(direction, isMoving, timestamp);
  const dx = cx - SPRITE_DISPLAY_SIZE / 2;
  const dy = cy - SPRITE_DISPLAY_SIZE / 2;

  return drawSpriteFrame(ctx, `${PREMADE_BASE}/${premadeId}`, {
    col, row, cellWidth: FRAME_SIZE, cellHeight: FRAME_SIZE,
    dx, dy, dWidth: SPRITE_DISPLAY_SIZE, dHeight: SPRITE_DISPLAY_SIZE,
  });
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

  const metrics = ctx.measureText(name);
  const tw = metrics.width;
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
  ctx.fillText(name, x, baseY);
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

  const metrics = ctx.measureText(tag);
  const tw = metrics.width;
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
