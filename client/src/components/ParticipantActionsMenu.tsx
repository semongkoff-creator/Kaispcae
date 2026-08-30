import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ThreeDotsVertical, PersonWalking, MagnetFill, HandIndexThumbFill, VolumeUpFill, VolumeMuteFill, ChatDotsFill, MegaphoneFill, FlagFill, MicMuteFill, PersonDashFill, GeoAltFill } from 'react-bootstrap-icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { showConfirm } from '@/stores/modalStore';

// Same MenuItem used by both ParticipantPanel and MemberListPanel — kept
// here so the two lists can't drift into two different menu row styles.
export function MenuItem({ icon, label, onClick, danger, detail }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; detail?: string }) {
  return (
    <Tooltip label={label} detail={detail} wrapperClassName="w-full">
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left cursor-pointer transition-colors ${
          danger
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
            : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
        }`}
      >
        <span className="shrink-0 w-4 flex justify-center">{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

export interface ParticipantActionsMenuProps {
  name: string;
  isFollowingThem?: boolean;
  isMuted?: boolean;
  spotlightActive?: boolean;
  onLocate?: () => void;
  onFollow?: () => void;
  onSummon?: () => void;
  onForcePull?: () => void;
  onSlap?: () => void;
  onToggleMute?: () => void;
  onMessage?: () => void;
  onSpotlight?: () => void;
  onReport?: () => void;
  onForceMute?: () => void;
  onKick?: () => void;
}

// The ⋮ trigger + its portal menu, exactly as ParticipantPanel had it
// inline — pulled out so MemberListPanel can render the identical menu
// (same items, same confirm dialogs, same permission gating via which
// props are undefined) without copy-pasting the portal positioning math.
export function ParticipantActionsMenu({
  name,
  isFollowingThem,
  isMuted,
  spotlightActive,
  onLocate,
  onFollow,
  onSummon,
  onForcePull,
  onSlap,
  onToggleMute,
  onMessage,
  onSpotlight,
  onReport,
  onForceMute,
  onKick,
}: ParticipantActionsMenuProps) {
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuOpen = menuPos !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenuPos(null), []);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuOpen, closeMenu]);

  const openMenu = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const MENU_W = 176;
    const MENU_H = 190;
    const openUp = r.bottom + MENU_H > window.innerHeight && r.top > MENU_H;
    const right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - MENU_W - 8));
    setMenuPos({ top: openUp ? r.top - MENU_H - 4 : r.bottom + 4, right });
  };

  const pick = (fn?: () => void) => () => { closeMenu(); fn?.(); };
  const hasActions = !!(onFollow || onSummon || onSlap || onToggleMute || onMessage || onReport || onKick || onForceMute || onForcePull || onSpotlight || onLocate);

  if (!hasActions) return null;

  return (
    <>
      <Tooltip label={`Aksi untuk ${name}`} detail="Buka menu aksi untuk orang ini.">
        <button
          ref={triggerRef}
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          className={`cursor-pointer rounded px-0.5 ${menuOpen ? 'text-purple-600 bg-purple-100 dark:bg-gray-600' : 'text-gray-400 dark:text-gray-500 hover:text-purple-600'}`}
        >
          <ThreeDotsVertical size={13} />
        </button>
      </Tooltip>
      {menuPos && createPortal(
        <div
          ref={popRef}
          style={{ top: menuPos.top, right: menuPos.right }}
          className="fixed z-[60] w-44 py-1 rounded-lg bg-white dark:bg-gray-800 border border-purple-200 dark:border-gray-600 shadow-xl overflow-hidden"
        >
          {onLocate && (
            <MenuItem icon={<GeoAltFill size={12} />} label="Temukan" detail="Pusatkan kamera ke posisi orang ini di peta." onClick={pick(onLocate)} />
          )}
          {!isFollowingThem && onFollow && (
            <MenuItem icon={<PersonWalking size={12} />} label="Ikuti" detail="Ikuti otomatis ke mana pun orang ini berjalan." onClick={pick(onFollow)} />
          )}
          {onSummon && (
            <MenuItem icon={<MagnetFill size={12} />} label="Panggil ke sini" detail="Undang orang ini ke lokasimu — dia harus menyetujui dulu." onClick={pick(onSummon)} />
          )}
          {onForcePull && (
            <MenuItem
              icon={<MagnetFill size={12} />}
              label="Tarik Paksa"
              detail="Pindahkan orang ini ke lokasimu langsung, tanpa persetujuan."
              danger
              onClick={pick(async () => { if (await showConfirm(`Tarik paksa ${name} ke sini? Tidak perlu persetujuan dia — beda dari "Panggil ke sini".`, { danger: true })) onForcePull(); })}
            />
          )}
          {onSlap && (
            <MenuItem icon={<HandIndexThumbFill size={12} />} label="Colek (sadarkan)" detail="Getarkan avatar orang ini sebentar untuk menarik perhatiannya." onClick={pick(onSlap)} />
          )}
          {onToggleMute && (
            <MenuItem
              icon={isMuted ? <VolumeUpFill size={12} /> : <VolumeMuteFill size={12} />}
              label={isMuted ? 'Batalkan bisukan' : 'Bisukan'}
              detail="Cuma mengubah suara yang KAMU dengar — mic orang ini tetap aktif untuk orang lain."
              onClick={pick(onToggleMute)}
            />
          )}
          {onMessage && (
            <MenuItem icon={<ChatDotsFill size={11} />} label="Kirim pesan" detail="Buka percakapan DM 1-on-1 dengan orang ini." onClick={pick(onMessage)} />
          )}
          {onSpotlight && (
            <MenuItem
              icon={<MegaphoneFill size={11} />}
              label={spotlightActive ? 'Matikan Spotlight' : 'Nyalakan Spotlight'}
              detail="Jadikan orang ini tampilan utama di Meeting View semua orang."
              onClick={pick(onSpotlight)}
            />
          )}
          {onReport && (
            <MenuItem icon={<FlagFill size={11} />} label="Laporkan" detail="Laporkan perilaku orang ini ke admin workspace." danger onClick={pick(onReport)} />
          )}
          {(onForceMute || onKick) && (
            <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          )}
          {onForceMute && (
            <MenuItem
              icon={<MicMuteFill size={12} />}
              label="Matikan Mic (Admin)"
              detail="Matikan mic orang ini secara paksa — dia bisa menyalakannya lagi sendiri."
              danger
              onClick={pick(async () => { if (await showConfirm(`Matikan mic ${name}? Dia bisa nyalain lagi sendiri kapan saja.`, { danger: true })) onForceMute(); })}
            />
          )}
          {onKick && (
            <MenuItem
              icon={<PersonDashFill size={12} />}
              label="Keluarkan"
              detail="Keluarkan orang ini dari room — dia bisa masuk lagi kapan saja."
              danger
              onClick={pick(async () => { if (await showConfirm(`Keluarkan ${name} dari room ini? Dia bisa masuk lagi kapan saja.`, { danger: true })) onKick(); })}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}