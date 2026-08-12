import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MicFill, MicMuteFill, CameraVideoFill, CameraVideoOffFill } from 'react-bootstrap-icons';
import { ProximityPlayer } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { getVideoTiles } from './VideoGrid';

// Chrome/Edge-only browser API (as of this writing) for a genuinely
// always-on-top floating window that keeps rendering live DOM content while
// the user switches to a different tab or a different application entirely
// — regular <video> Picture-in-Picture (already on every VideoTile) only
// ever floats a single raw video element; this floats an actual mini UI
// with everyone's tiles plus working mic/camera buttons.
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export function isMiniModeSupported(): boolean {
  return typeof window !== 'undefined' && !!window.documentPictureInPicture;
}

// Opening the PiP window has to happen directly inside the click handler
// that triggers it (a real, un-replayed user gesture — the browser rejects
// requestWindow() without one) and exactly once — NOT inside a component's
// mount effect, which React 18 StrictMode deliberately double-invokes in
// dev. requestWindow() isn't idempotent like a state update: double-invoking
// it opens a second real OS window and promptly closes the first, so the
// caller (App.tsx) owns creating the window and only mounts <MiniMode>
// once it already exists.
export async function openMiniModeWindow(): Promise<Window | null> {
  if (!window.documentPictureInPicture) return null;

  // The browser tracks at most one Document PiP window per tab and throws
  // an InvalidStateError from requestWindow() if it thinks one is already
  // open — including a stale reference left over from a previous room (see
  // App.tsx's key={roomSlug} remount) if its close() call raced with this
  // one, or from the window still finishing its own close animation. Without
  // this, that throw was completely unhandled: requestWindow() rejected, the
  // click's async handler had no .catch, and the whole thing failed
  // silently — the button visibly did nothing, with no error and nothing
  // in the UI telling the user why. Closing any window the API still thinks
  // is open first, before asking for a new one, clears that stuck state.
  if (window.documentPictureInPicture.window) {
    try { window.documentPictureInPicture.window.close(); } catch { /* already gone */ }
  }

  let win: Window;
  try {
    win = await window.documentPictureInPicture.requestWindow({ width: 300, height: 220 });
  } catch (e) {
    console.warn('[minimode] requestWindow failed:', e);
    return null;
  }

  // Everything below is best-effort styling/setup on a window the browser
  // has ALREADY created — a failure here must not throw back out to the
  // caller (that previously meant a real, visible OS window popped open
  // with nothing in it, while the app itself treated the whole thing as if
  // it had silently failed: no MiniMode content ever got portaled in
  // because the exception happened before the `return win` below, and
  // there was no visible error either, since nothing here was caught).
  try {
    // Copy every stylesheet/style tag over — the PiP window starts with a
    // blank document, so without this the portaled content would render
    // completely unstyled (no Tailwind classes applied at all).
    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        const cssRules = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        const style = win.document.createElement('style');
        style.textContent = cssRules;
        win.document.head.appendChild(style);
      } catch {
        // Cross-origin stylesheets throw on .cssRules — link it instead.
        try {
          if (sheet.href) {
            const link = win.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            win.document.head.appendChild(link);
          }
        } catch (linkErr) {
          console.warn('[minimode] failed to link stylesheet, skipping:', linkErr);
        }
      }
    });
    win.document.title = 'KaiSpace — Mini Mode';
    win.document.body.style.margin = '0';
    win.document.body.style.background = '#111827';
  } catch (e) {
    console.warn('[minimode] window setup failed (opening unstyled):', e);
  }
  return win;
}

interface MiniModeProps {
  pipWindow: Window;
  nearby: ProximityPlayer[];
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteScreenStreams: Map<string, MediaStream>;
  micMuted: boolean;
  cameraOff: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onClose: () => void;
}

// Renders into a separate always-on-top OS-level window via the Document
// Picture-in-Picture API, not into the normal page — the whole point is
// that this content keeps showing while this browser tab is out of focus
// (a different tab, or a completely different application window). The
// window itself is opened by openMiniModeWindow() above and handed in
// already-created — this component only portals content into it and
// watches for it being closed.
export function MiniMode({ pipWindow, nearby, localStream, remoteStreams, remoteScreenStreams, micMuted, cameraOff, onToggleMic, onToggleCamera, onClose }: MiniModeProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // The PiP window closes via its own native close button (no React
    // control over that) — this is the only way to notice and clean up.
    // Adding/removing this listener is side-effect-free either way, unlike
    // requestWindow() above, so StrictMode double-invoking it is harmless.
    const handlePageHide = () => onCloseRef.current();
    pipWindow.addEventListener('pagehide', handlePageHide);
    return () => pipWindow.removeEventListener('pagehide', handlePageHide);
  }, [pipWindow]);

  // React 18 StrictMode (see main.tsx) deliberately mounts every component
  // twice in dev — run effect, run its cleanup, run the effect again — to
  // surface exactly this class of bug: an effect whose cleanup has a REAL,
  // non-idempotent side effect. requestWindow() above was already fixed for
  // this (moved out of an effect entirely, see its own comment), but the
  // effect below closes the window in ITS cleanup, so StrictMode's
  // simulated first cleanup closed the freshly opened window for real
  // before the "real" mount ever got a chance to use it — Mini Mode looked
  // like it opened for an instant and immediately closed. skipFirstCleanup
  // swallows exactly that one synthetic cleanup; every cleanup after it
  // (including the eventual genuine unmount) still closes the window.
  const skipFirstCleanupRef = useRef(true);
  useEffect(() => {
    // The other direction of the same problem: this component can also
    // disappear because the APP navigated away (left the room, logged out)
    // while the PiP window was still open — an SPA route change never
    // unloads the actual document, so the window has no other signal that
    // it's meant to close. Without this, that real OS-level window is
    // simply abandoned, blank, with nothing left in the app that could ever
    // close it. Calling close() on a window already mid-close (the pagehide
    // path above) is a documented no-op, so this is safe either way.
    return () => {
      if (skipFirstCleanupRef.current) {
        skipFirstCleanupRef.current = false;
        return;
      }
      try {
        pipWindow.close();
      } catch {
        // Already closed — nothing to do.
      }
    };
  }, [pipWindow]);

  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams);

  return createPortal(
    <div className="w-full h-full flex flex-col bg-gray-900 text-white p-2 gap-2 overflow-y-auto">
      <div className="grid grid-cols-2 gap-1.5">
        {localStream && <MiniTile name="You" stream={localStream} muted micMuted={micMuted} cameraOff={cameraOff} />}
        {/* Mini Mode stays camera-only (its empty state literally says
            "Nobody's on camera") — the streamless proximity tiles that the
            main column now shows would just be blank boxes in this compact
            PiP, so they're filtered out here. */}
        {videoTiles.filter((t) => t.stream).map((tile) => (
          <MiniTile key={tile.id} name={tile.name} stream={tile.stream!} />
        ))}
      </div>
      {videoTiles.length === 0 && !localStream && (
        <p className="text-white/40 text-xs text-center my-auto">Nobody's on camera right now.</p>
      )}
      <div className="mt-auto flex items-center justify-center gap-2 pt-1">
        <button
          onClick={onToggleMic}
          className={`w-8 h-8 rounded-full flex items-center justify-center cursor-pointer ${micMuted ? 'bg-red-600' : 'bg-white/15 hover:bg-white/25'}`}
        >
          {micMuted ? <MicMuteFill size={14} /> : <MicFill size={14} />}
        </button>
        <button
          onClick={onToggleCamera}
          className={`w-8 h-8 rounded-full flex items-center justify-center cursor-pointer ${cameraOff ? 'bg-red-600' : 'bg-white/15 hover:bg-white/25'}`}
        >
          {cameraOff ? <CameraVideoOffFill size={14} /> : <CameraVideoFill size={14} />}
        </button>
      </div>
    </div>,
    pipWindow.document.body,
  );
}

function MiniTile({ name, stream, muted, micMuted, cameraOff }: { name: string; stream: MediaStream; muted?: boolean; micMuted?: boolean; cameraOff?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="relative rounded overflow-hidden bg-black aspect-video">
      <video ref={videoRef} autoPlay playsInline muted={muted} className="w-full h-full object-cover" />
      <span className="absolute bottom-0.5 left-1 text-[9px] text-white/90 drop-shadow">{name}</span>
      {(micMuted || cameraOff) && (
        <span className="absolute top-0.5 right-1 flex gap-0.5">
          {micMuted && <MicMuteFill size={9} className="text-red-400" />}
          {cameraOff && <CameraVideoOffFill size={9} className="text-red-400" />}
        </span>
      )}
    </div>
  );
}
