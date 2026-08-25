import type { QualityLevel } from '@/services/connectionQuality';

// Three bars, because that is the shape everyone already knows from a phone.
//
// The one deviation from the familiar version: zero bars means "no measurement
// yet", not "dead". A peer that just connected has no loss delta to compare
// against (see samplePeerQuality's baseline note), and showing that as an
// empty meter would report every new arrival as broken for their first five
// seconds. Unknown is drawn hollow rather than empty-and-red so the two states
// cannot be confused at a glance.

const FILLED: Record<QualityLevel, string> = {
  good: 'bg-emerald-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const LABEL: Record<QualityLevel, string> = {
  good: 'Koneksi bagus',
  fair: 'Koneksi sedang',
  poor: 'Koneksi buruk',
  unknown: 'Koneksi belum terukur',
};

// Ascending heights, so the meter reads as a meter even in greyscale — colour
// alone would leave this unreadable to red/green colour blindness, which is
// roughly one man in twelve.
const HEIGHTS = ['h-1.5', 'h-2.5', 'h-3.5'];

export function SignalBars({
  level,
  bars,
  relayed = false,
  title,
}: {
  level: QualityLevel;
  bars: 0 | 1 | 2 | 3;
  relayed?: boolean;
  title?: string;
}) {
  const text = title ?? LABEL[level];
  return (
    <span
      className="inline-flex items-end gap-0.5"
      title={relayed ? `${text} · lewat relay` : text}
      aria-label={text}
      role="img"
    >
      {HEIGHTS.map((h, i) => (
        <span
          key={h}
          className={`w-1 rounded-sm ${h} ${
            i < bars ? FILLED[level] : 'bg-gray-200 dark:bg-gray-700'
          }`}
        />
      ))}
      {relayed && (
        // A relayed peer is not a fault — it is the reason the numbers beside
        // it look worse than the person's connection deserves, so it is worth
        // one character of screen space.
        <span className="ml-0.5 text-[10px] leading-none text-gray-500 dark:text-gray-400" aria-hidden>
          ↻
        </span>
      )}
    </span>
  );
}
