import { useState, useRef, useEffect, useCallback } from 'react';
import {
  BodyShape,
  Accessory,
  Expression,
  AvatarConfig,
} from '@virtualmeet/shared';
import { drawAvatar } from '@/components/canvas/AvatarSprite';
import { PALETTE } from '@/hooks/useAvatarConfig';

const BODY_SHAPES: { value: BodyShape; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'rounded-square', label: 'Square' },
  { value: 'hexagon', label: 'Hexagon' },
];

const ACCESSORIES: { value: Accessory; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'cap', label: 'Cap' },
  { value: 'crown', label: 'Crown' },
  { value: 'headphones', label: 'Phones' },
  { value: 'halo', label: 'Halo' },
  { value: 'bow', label: 'Bow' },
];

const EXPRESSIONS: { value: Expression; label: string; emoji: string }[] = [
  { value: 'neutral', label: 'Neutral', emoji: '😐' },
  { value: 'happy', label: 'Happy', emoji: '😊' },
  { value: 'cool', label: 'Cool', emoji: '😎' },
  { value: 'thinking', label: 'Think', emoji: '🤔' },
  { value: 'sleepy', label: 'Sleepy', emoji: '😴' },
];

interface AvatarSetupProps {
  initialConfig?: AvatarConfig;
  onSave: (config: AvatarConfig) => void;
  onClose?: () => void;
}

export function AvatarSetup({ initialConfig, onSave, onClose }: AvatarSetupProps) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState<AvatarConfig>(() => ({
    bodyShape: initialConfig?.bodyShape || 'circle',
    color: initialConfig?.color || PALETTE[0],
    accessory: initialConfig?.accessory || 'none',
    expression: initialConfig?.expression || 'neutral',
    name: initialConfig?.name || 'You',
    statusTag: initialConfig?.statusTag || '',
  }));

  const setField = useCallback(
    <K extends keyof AvatarConfig>(key: K, value: AvatarConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

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
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl border border-white/10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white text-xl font-bold">Customize Avatar</h2>
          {onClose && (
            <button onClick={handleClose} className="text-white/50 hover:text-white text-lg leading-none">&times;</button>
          )}
        </div>

        {/* Live Preview */}
        <div className="flex justify-center mb-6">
          <canvas ref={previewRef} className="rounded-xl bg-gray-900/50" />
        </div>

        {/* Body Shape */}
        <Section label="Body Shape">
          <div className="flex gap-2">
            {BODY_SHAPES.map((bs) => (
              <button
                key={bs.value}
                onClick={() => setField('bodyShape', bs.value)}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                  config.bodyShape === bs.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-700 text-white/60 hover:bg-gray-600'
                }`}
              >
                {bs.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Color */}
        <Section label="Color">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((color) => (
              <button
                key={color}
                onClick={() => setField('color', color)}
                className="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: color,
                  borderColor: config.color === color ? '#fff' : 'transparent',
                }}
              />
            ))}
            {/* Custom color picker */}
            <label className="w-8 h-8 rounded-full cursor-pointer flex items-center justify-center bg-gray-700 border-2 border-transparent hover:scale-110 transition-transform">
              <span className="text-white/40 text-lg leading-none">+</span>
              <input
                type="color"
                value={config.color}
                onChange={(e) => setField('color', e.target.value)}
                className="absolute opacity-0 w-0 h-0"
              />
            </label>
          </div>
        </Section>

        {/* Accessory */}
        <Section label="Accessory">
          <div className="flex flex-wrap gap-2">
            {ACCESSORIES.map((acc) => (
              <button
                key={acc.value}
                onClick={() => setField('accessory', acc.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  config.accessory === acc.value
                    ? 'bg-purple-500 text-white'
                    : 'bg-gray-700 text-white/60 hover:bg-gray-600'
                }`}
              >
                {acc.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Expression */}
        <Section label="Expression">
          <div className="flex flex-wrap gap-2">
            {EXPRESSIONS.map((exp) => (
              <button
                key={exp.value}
                onClick={() => setField('expression', exp.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  config.expression === exp.value
                    ? 'bg-emerald-500 text-white'
                    : 'bg-gray-700 text-white/60 hover:bg-gray-600'
                }`}
              >
                {exp.emoji} {exp.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Display Name */}
        <Section label="Display Name">
          <input
            type="text"
            value={config.name}
            onChange={(e) => setField('name', e.target.value.slice(0, 20))}
            maxLength={20}
            className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 outline-none border border-white/10 focus:border-blue-400 transition-colors text-sm"
            placeholder="Your display name"
          />
          <span className="text-white/30 text-xs mt-1 block">{config.name.length}/20</span>
        </Section>

        {/* Status Tag */}
        <Section label="Status Tag">
          <input
            type="text"
            value={config.statusTag}
            onChange={(e) => setField('statusTag', e.target.value.slice(0, 10))}
            maxLength={10}
            className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 outline-none border border-white/10 focus:border-blue-400 transition-colors text-sm"
            placeholder="e.g. dev, design, AFK"
          />
          <span className="text-white/30 text-xs mt-1 block">{config.statusTag.length}/10</span>
        </Section>

        {/* Actions */}
        <div className="flex gap-3 mt-5">
          {onClose && (
            <button
              onClick={handleClose}
              className="flex-1 py-2.5 rounded-lg bg-gray-700 text-white/60 hover:bg-gray-600 font-medium text-sm transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-semibold text-sm transition-colors"
          >
            {onClose ? 'Save & Apply' : 'Join Room'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-white/70 text-xs font-semibold uppercase tracking-wider mb-2">{label}</p>
      {children}
    </div>
  );
}
