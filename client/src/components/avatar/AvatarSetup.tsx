import { useState, useRef, useEffect, useCallback } from 'react';
import { AvatarConfig, SpriteMode } from '@virtualmeet/shared';
import { drawAvatar } from '@/components/canvas/AvatarSprite';
import { PALETTE } from '@/hooks/useAvatarConfig';
import {
  GENERATOR_BODIES,
  GENERATOR_EYES,
  GENERATOR_OUTFITS,
  GENERATOR_HAIRSTYLES,
  GENERATOR_ACCESSORIES,
  PREMADE_CHARACTERS,
} from '@/data/spriteManifest';

// Cycles through `options`, wrapping around. When `allowNone` is set, an
// extra "no selection" (undefined) slot is inserted at the front — used for
// optional layers like hair/accessory.
function cycleOption(options: string[], current: string | undefined, dir: 1 | -1, allowNone: boolean): string | undefined {
  const list: (string | undefined)[] = allowNone ? [undefined, ...options] : options;
  const idx = list.findIndex((v) => v === current);
  const from = idx === -1 ? 0 : idx;
  const next = (from + dir + list.length) % list.length;
  return list[next];
}

function describeSelection(options: string[], current: string | undefined, allowNone: boolean): string {
  if (allowNone && !current) return `None (0/${options.length})`;
  const idx = options.indexOf(current || '');
  const position = idx === -1 ? 1 : idx + 1;
  return `${position}/${options.length}`;
}

interface SpriteCategory {
  key: 'bodyId' | 'eyesId' | 'outfitId' | 'hairId' | 'spriteAccessoryId';
  label: string;
  options: string[];
  allowNone: boolean;
}

const SPRITE_CATEGORIES: SpriteCategory[] = [
  { key: 'bodyId', label: 'Body', options: GENERATOR_BODIES, allowNone: false },
  { key: 'eyesId', label: 'Eyes', options: GENERATOR_EYES, allowNone: false },
  { key: 'outfitId', label: 'Outfit', options: GENERATOR_OUTFITS, allowNone: false },
  { key: 'hairId', label: 'Hairstyle', options: GENERATOR_HAIRSTYLES, allowNone: true },
  { key: 'spriteAccessoryId', label: 'Accessory', options: GENERATOR_ACCESSORIES, allowNone: true },
];

interface AvatarSetupProps {
  initialConfig?: AvatarConfig;
  onSave: (config: AvatarConfig) => void;
  onClose?: () => void;
}

export function AvatarSetup({ initialConfig, onSave, onClose }: AvatarSetupProps) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState<AvatarConfig>(() => ({
    ...initialConfig,
    bodyShape: initialConfig?.bodyShape || 'circle',
    color: initialConfig?.color || PALETTE[0],
    accessory: initialConfig?.accessory || 'none',
    expression: initialConfig?.expression || 'neutral',
    name: initialConfig?.name || 'You',
    statusTag: initialConfig?.statusTag || '',
    spriteMode: initialConfig?.spriteMode || 'layered',
    bodyId: initialConfig?.bodyId || GENERATOR_BODIES[0],
    eyesId: initialConfig?.eyesId || GENERATOR_EYES[0],
    outfitId: initialConfig?.outfitId || GENERATOR_OUTFITS[0],
  }));

  const setField = useCallback(
    <K extends keyof AvatarConfig>(key: K, value: AvatarConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const setTab = useCallback((tab: SpriteMode) => {
    setConfig((prev) => {
      if (tab === 'premade' && !prev.premadeId) {
        return { ...prev, spriteMode: tab, premadeId: PREMADE_CHARACTERS[0] };
      }
      return { ...prev, spriteMode: tab };
    });
  }, []);

  const cycleCategory = useCallback((cat: SpriteCategory, dir: 1 | -1) => {
    setConfig((prev) => ({
      ...prev,
      [cat.key]: cycleOption(cat.options, prev[cat.key] as string | undefined, dir, cat.allowNone),
    }));
  }, []);

  const cyclePremade = useCallback((dir: 1 | -1) => {
    setConfig((prev) => ({
      ...prev,
      premadeId: cycleOption(PREMADE_CHARACTERS, prev.premadeId, dir, false),
    }));
  }, []);

  const handleSave = () => {
    const trimmed = { ...config, name: config.name.trim() || 'You', statusTag: config.statusTag.trim().slice(0, 10) };
    setConfig(trimmed);
    onSave(trimmed);
  };

  const handleClose = () => {
    onClose?.();
  };

  // Live preview canvas
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = 120 * dpr;
    canvas.height = 120 * dpr;
    canvas.style.width = '120px';
    canvas.style.height = '120px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, 120, 120);

    drawAvatar(ctx, {
      avatar: {
        id: 'preview',
        name: config.name,
        x: 0,
        y: 0,
        direction: 'down',
        color: config.color,
        isMoving: false,
        avatarConfig: config,
      },
      x: 60,
      y: 55,
      isLocal: false,
      walkAnimOffset: 0,
    });
  }, [config]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl shadow-purple-100/50 border border-purple-100">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-gray-900 text-xl font-bold">Customize Avatar</h2>
          {onClose && (
            <button onClick={handleClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">&times;</button>
          )}
        </div>

        {/* Live Preview */}
        <div className="flex justify-center mb-4">
          <canvas ref={previewRef} className="rounded-xl bg-purple-50" />
        </div>

        {/* Mode tabs */}
        <div className="flex gap-2 mb-5 bg-purple-50 rounded-lg p-1">
          <button
            onClick={() => setTab('layered')}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
              config.spriteMode === 'layered' ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            🛠️ Build Character
          </button>
          <button
            onClick={() => setTab('premade')}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
              config.spriteMode === 'premade' ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            ⚡ Quick Pick
          </button>
        </div>

        {config.spriteMode === 'premade' ? (
          <Section label="Character">
            <CyclePicker
              label="Premade Character"
              value={describeSelection(PREMADE_CHARACTERS, config.premadeId, false)}
              onPrev={() => cyclePremade(-1)}
              onNext={() => cyclePremade(1)}
            />
            <p className="text-gray-400 text-[10px] mt-2 leading-relaxed">
              Ready-made character combos — no need to mix layers yourself.
            </p>
          </Section>
        ) : (
          <Section label="Appearance">
            {SPRITE_CATEGORIES.map((cat) => (
              <CyclePicker
                key={cat.key}
                label={cat.label}
                value={describeSelection(cat.options, config[cat.key] as string | undefined, cat.allowNone)}
                onPrev={() => cycleCategory(cat, -1)}
                onNext={() => cycleCategory(cat, 1)}
              />
            ))}
          </Section>
        )}

        {/* Identity Color — used for minimap dot, chat name dot, etc. */}
        <Section label="Identity Color">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((color) => (
              <button
                key={color}
                onClick={() => setField('color', color)}
                className="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: color,
                  borderColor: config.color === color ? '#7c3aed' : 'transparent',
                }}
              />
            ))}
            {/* Custom color picker */}
            <label className="w-8 h-8 rounded-full cursor-pointer flex items-center justify-center bg-purple-50 border-2 border-transparent hover:scale-110 transition-transform">
              <span className="text-gray-400 text-lg leading-none">+</span>
              <input
                type="color"
                value={config.color}
                onChange={(e) => setField('color', e.target.value)}
                className="absolute opacity-0 w-0 h-0"
              />
            </label>
          </div>
        </Section>

        {/* Display Name */}
        <Section label="Display Name">
          <input
            type="text"
            value={config.name}
            onChange={(e) => setField('name', e.target.value.slice(0, 20))}
            maxLength={20}
            className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-3 py-2 outline-none border border-purple-100 focus:border-purple-500 transition-colors text-sm"
            placeholder="Your display name"
          />
          <span className="text-gray-400 text-xs mt-1 block">{config.name.length}/20</span>
        </Section>

        {/* Status Tag */}
        <Section label="Status Tag">
          <input
            type="text"
            value={config.statusTag}
            onChange={(e) => setField('statusTag', e.target.value.slice(0, 10))}
            maxLength={10}
            className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-3 py-2 outline-none border border-purple-100 focus:border-purple-500 transition-colors text-sm"
            placeholder="e.g. dev, design, AFK"
          />
          <span className="text-gray-400 text-xs mt-1 block">{config.statusTag.length}/10</span>
        </Section>

        {/* Actions */}
        <div className="flex gap-3 mt-5">
          {onClose && (
            <button
              onClick={handleClose}
              className="flex-1 py-2.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 font-medium text-sm transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm transition-colors"
          >
            {onClose ? 'Save & Apply' : 'Join Room'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CyclePicker({ label, value, onPrev, onNext }: { label: string; value: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-between bg-purple-50 rounded-lg px-2 py-2 mb-2">
      <button
        onClick={onPrev}
        className="w-7 h-7 flex items-center justify-center rounded-md bg-white text-purple-600 hover:bg-purple-100 shadow-sm cursor-pointer text-sm"
      >
        ◀
      </button>
      <div className="text-center">
        <p className="text-gray-900 text-xs font-medium">{label}</p>
        <p className="text-gray-400 text-[10px] font-mono">{value}</p>
      </div>
      <button
        onClick={onNext}
        className="w-7 h-7 flex items-center justify-center rounded-md bg-white text-purple-600 hover:bg-purple-100 shadow-sm cursor-pointer text-sm"
      >
        ▶
      </button>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">{label}</p>
      {children}
    </div>
  );
}
