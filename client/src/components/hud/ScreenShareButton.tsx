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
        // (see MicButton's own comment on that restyle) — this button keeps
        // a solid fill in BOTH states, not just while sharing. Round (not
        // the earlier rounded-square) and the app's own accent blue
        // (login-accent, #717BD8 — already used everywhere else in this app
        // for "active/accent" fills, not a new one-off color), matching the
        // reference screenshot exactly rather than the dark-square guess
        // from the previous pass.
        className="relative flex items-center justify-center w-9 h-9 rounded-full bg-login-accent shadow-md transition-all hover:scale-105 hover:brightness-110 cursor-pointer"
      >
        {sharing ? (
          <DisplayFill className="text-white" size={15} />
        ) : (
          // share_screen.svg is two-tone by default (dark gray monitor body,
          // white arrow) — meant for a light background. brightness-0 invert
          // flattens it to a solid white silhouette instead, matching
          // "white icon on the accent circle" (same filter trick used
          // elsewhere for icons that need forcing to white — see the
          // top-left pill's Status/My Seat buttons in App.tsx).
          <img src="/assets/img/icons/share_screen.svg" width={15} height={15} alt="" className="brightness-0 invert" />
        )}
        {sharing && (
          <div className="absolute inset-0 rounded-full border-2 border-purple-300 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
