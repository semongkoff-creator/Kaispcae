import { DisplayFill } from 'react-bootstrap-icons';
import { Tooltip } from '@/components/ui/Tooltip';

interface ScreenShareButtonProps {
  sharing: boolean;
  onToggle: () => void;
}

// No keyboard shortcut here on purpose — every free letter key doubles as a
// WASD movement key (S in particular collides directly with "move down"),
// so this button is click-only.
//
// §6 — most mobile browsers don't implement getDisplayMedia at all, so
// feature-detecting it (rather than user-agent sniffing, which the spec
// offers as an alternative) hides the button wherever it could never work,
// instead of showing it and failing only once tapped.
const SCREEN_SHARE_SUPPORTED = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export function ScreenShareButton({ sharing, onToggle }: ScreenShareButtonProps) {
  if (!SCREEN_SHARE_SUPPORTED) return null;

  return (
    <Tooltip
      label={`Bagikan Layar — ${sharing ? 'Aktif' : 'Mati'}`}
      detail="Bagikan layar atau jendela aplikasimu ke semua orang yang sedang di zone/meeting yang sama."
    >
      <button
        onClick={onToggle}
        // The one exception to the rest of this bar's flat/borderless icons
        // (see MicButton's own comment on that restyle) — a solid filled
        // ROUNDED-SQUARE (back to this from a circle — a later reference
        // crop showed clearly rounded corners, not a full circle, matching
        // the very first description of this button before two rounds of
        // guessing at shape/color from cropped screenshots). Fill color
        // follows the app's own established gray/green pair (mic.svg
        // #6E6D72 / mic_on.svg #54D678 — see MicButton): gray at rest, green
        // while actively sharing, mirroring how Mic itself distinguishes
        // idle from active.
        className={`relative flex items-center justify-center w-8 h-8 rounded-lg shadow-md transition-all hover:scale-105 hover:brightness-110 cursor-pointer ${
          sharing ? 'bg-[#54D678]' : 'bg-[#6E6D72]'
        }`}
      >
        {sharing ? (
          <DisplayFill className="text-white" size={14} />
        ) : (
          // share_screen.svg is two-tone by default (dark gray monitor body,
          // white arrow) — meant for a light background. brightness-0 invert
          // flattens it to a solid white silhouette instead, matching
          // "white icon on the filled square" (same filter trick used
          // elsewhere for icons that need forcing to white — see the
          // top-left pill's Status/My Seat buttons in App.tsx).
          <img src="/assets/img/icons/share_screen.svg" width={14} height={14} alt="" className="brightness-0 invert" />
        )}
        {sharing && (
          <div className="absolute inset-0 rounded-lg border-2 border-green-300 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
