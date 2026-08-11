import { ReactNode, useEffect, useRef, useState } from 'react';
import { XLg, Joystick, CameraVideoFill, Grid3x3GapFill, ExclamationTriangleFill, CameraFill, Headset, ImageFill } from 'react-bootstrap-icons';

// ZEP-style User Guide — one page, sidebar nav on the left scrolls to the
// matching section on the right (not separate tabs/routes). Replaces the
// old dismissible reopen of TutorialModal.tsx (Sidebar's "Panduan" row —
// see App.tsx) with this richer, section+screenshot format; the two
// MANDATORY first-run walkthroughs (new account / new guest, both still
// TutorialModal) are untouched — different purpose (a forced onboarding
// gate before Game ever mounts), out of scope here.
interface GuideImage {
  // Convention: drop a real PNG at this exact path under client/public and
  // it replaces the placeholder automatically — no code change needed (see
  // GuideImageSlot's onError fallback below).
  src: string;
  label: string;
}
interface GuideStep {
  text: string;
  image?: GuideImage;
}
interface GuideSection {
  id: string;
  navLabel: string;
  title: string;
  icon: ReactNode;
  intro?: string;
  steps: GuideStep[];
}

// Text below is a first draft, verified against the actual feature code
// (hotkeys, button locations, behavior) rather than guessed — see the
// individual step comments for anything non-obvious. Expected to be edited
// directly here as copy gets corrected.
const SECTIONS: GuideSection[] = [
  {
    id: 'general',
    navLabel: 'General Operation',
    title: 'General Operation Method',
    icon: <Joystick size={15} />,
    steps: [
      { text: 'Gerak pakai tombol panah atau W A S D. Bisa juga klik langsung di peta — karaktermu otomatis jalan ke sana, mencari jalan sendiri tanpa nabrak meja/tembok.', image: { src: '/assets/img/guide/general-langkah-1.png', label: 'Gerak & klik-untuk-jalan' } },
      { text: 'Tahan Shift atau R sambil jalan untuk lari lebih cepat.', image: { src: '/assets/img/guide/general-langkah-2.png', label: 'Lari (Shift/R)' } },
      { text: 'Tombol interaksi: Space (duduk di kursi terdekat / lompat), X (buka gambar-video-file di dekatmu), F (pakai teleport/pintu/objek interaktif terdekat), Z (colek orang terdekat).', image: { src: '/assets/img/guide/general-langkah-3.png', label: 'Tombol interaksi' } },
      { text: 'Masuk room: klik kartu room-nya di Lobby. Keluar: klik ikon rumah di sidebar kiri, atau tombol merah di toolbar bawah — kamu tetap login, cuma balik ke daftar Space.', image: { src: '/assets/img/guide/general-langkah-4.png', label: 'Masuk & keluar room' } },
    ],
  },
  {
    id: 'audio-video',
    navLabel: 'Audio/Video Guide',
    title: 'Audio/Video Guide',
    icon: <CameraVideoFill size={15} />,
    steps: [
      { text: 'Mic: klik tombol mikrofon di toolbar bawah, atau tekan M.', image: { src: '/assets/img/guide/av-langkah-1.png', label: 'Mute/unmute mic' } },
      { text: 'Kamera: klik tombol kamera, atau tekan V.', image: { src: '/assets/img/guide/av-langkah-2.png', label: 'Nyala/mati kamera' } },
      { text: 'Suara otomatis mengeras/pelan sesuai jarak avatar (proximity) — tidak perlu klik "join call" seperti Zoom.', image: { src: '/assets/img/guide/av-langkah-3.png', label: 'Proximity audio' } },
      { text: 'Share screen: klik tombol share-screen di toolbar bawah untuk mulai, klik lagi untuk berhenti.', image: { src: '/assets/img/guide/av-langkah-4.png', label: 'Share screen' } },
      { text: 'Atur volume satu orang saja (tanpa mematikan mic-nya): arahkan kursor ke tile video orang itu, slider muncul di tempat namanya.', image: { src: '/assets/img/guide/av-langkah-5.png', label: 'Volume per orang' } },
      { text: 'Ganti mic/speaker/kamera yang dipakai: klik ikon titik-tiga (⋮) di toolbar bawah.', image: { src: '/assets/img/guide/av-langkah-6.png', label: 'Pilih device' } },
    ],
  },
  {
    id: 'app-features',
    navLabel: 'App User Guide',
    title: 'App User Guide',
    icon: <Grid3x3GapFill size={15} />,
    intro: 'Ringkasan fitur-fitur utama KaiSpace.',
    steps: [
      { text: 'Ruang: bikin Space baru (khusus akun admin) lewat tombol "+ Create Space" di Lobby, atau join room lewat kartu / tombol "Join with Code".', image: { src: '/assets/img/guide/app-ruang.png', label: 'Buat/join room' } },
      { text: 'Chat: ada channel bersama, DM 1-on-1 (lewat menu di panel Peserta), @mention, kirim file/gambar, dan pin pesan (khusus admin).', image: { src: '/assets/img/guide/app-chat.png', label: 'Chat' } },
      { text: 'Meeting View: tampilan video-call layar penuh. Klik tile siapa pun untuk menyorotnya jadi tampilan utama.', image: { src: '/assets/img/guide/app-meeting-view.png', label: 'Meeting View' } },
      { text: 'Booking CEO: tekan G di mana pun di dalam room untuk ajukan jadwal ngobrol dengan CEO — otomatis masuk ruangannya begitu jamnya tiba dan disetujui.', image: { src: '/assets/img/guide/app-booking-ceo.png', label: 'Booking CEO (tombol G)' } },
      { text: 'Guest Link: admin bisa bikin link undangan + password untuk tamu tanpa akun, lewat menu Room Features.', image: { src: '/assets/img/guide/app-guest-link.png', label: 'Guest Link' } },
      { text: 'Lainnya: kunci zona/ruangan, kursi tetap ("My Seat"), panggil orang lain ke lokasimu (Summon), reaksi emoji, dan angkat tangan.', image: { src: '/assets/img/guide/app-lainnya.png', label: 'Fitur lainnya' } },
    ],
  },
  {
    id: 'troubleshooting',
    navLabel: 'Problem Solving',
    title: 'Problem Solving Checklist',
    icon: <ExclamationTriangleFill size={15} />,
    steps: [
      { text: 'Mic tidak bunyi → cek izin mikrofon di pengaturan browser, cek device yang aktif lewat menu ⋮ di toolbar, pastikan tombol mic tidak sedang merah (mute).', image: { src: '/assets/img/guide/trouble-mic.png', label: 'Mic tidak bunyi' } },
      { text: 'Kamera hitam / tidak muncul → cek izin kamera di browser, cek pilihan device lewat menu ⋮.', image: { src: '/assets/img/guide/trouble-camera.png', label: 'Kamera hitam' } },
      { text: 'Tidak bisa masuk room → room-nya mungkin perlu persetujuan admin (tunggu approval), atau kamu tamu yang belum di-approve masuk zona tertentu.' },
      { text: 'Tidak dengar / tidak lihat orang lain → cek indikator "Koneksi terputus" di tile-nya dulu; kalau tidak ada, coba dekati lagi (ini aplikasi proximity-based) atau cek slider volume orang itu belum sengaja dikecilkan.' },
    ],
  },
  {
    id: 'screenshot',
    navLabel: 'Screenshot',
    title: 'Screenshot',
    icon: <CameraFill size={15} />,
    steps: [
      { text: 'Buka menu ☰ (Room Features) di sidebar kiri, lalu klik "Add Media".', image: { src: '/assets/img/guide/screenshot-langkah-1.png', label: 'Buka Add Media' } },
      { text: 'Klik tombol "Screenshot" — otomatis mengunduh gambar peta (tanpa ikut ter-foto UI/chat/sidebar) ke komputermu.', image: { src: '/assets/img/guide/screenshot-langkah-2.png', label: 'Klik tombol Screenshot' } },
    ],
  },
  {
    id: 'cs-center',
    navLabel: 'Customer Service',
    title: 'Customer Service Center',
    icon: <Headset size={15} />,
    steps: [
      { text: 'Klik ikon headset ungu mengambang di pojok kiri-bawah layar untuk membuka Chat CS.', image: { src: '/assets/img/guide/cs-langkah-1.png', label: 'Buka Chat CS' } },
      { text: 'Tanya seputar cara pakai KaiSpace — bot akan coba jawab otomatis.', image: { src: '/assets/img/guide/cs-langkah-2.png', label: 'Tanya ke bot' } },
      { text: 'Kalau bot belum punya jawabannya, klik "Hubungi admin" yang muncul untuk diteruskan ke tim CS.' },
    ],
  },
];

// Tries the real screenshot first; falls back to a clearly-labeled
// placeholder (showing the exact path expected) if it 404s — i.e. before
// the real file has been dropped in. No code change needed once it has:
// this just starts rendering it the next time the image loads successfully.
function GuideImageSlot({ src, label }: GuideImage) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="border-2 border-dashed border-purple-200 dark:border-gray-600 rounded-lg bg-purple-50/50 dark:bg-gray-900/40 flex flex-col items-center justify-center gap-1.5 py-8 px-4 text-center">
        <ImageFill size={22} className="text-purple-300 dark:text-gray-600" />
        <p className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">GAMBAR: {label}</p>
        <p className="text-[10px] text-gray-400 dark:text-gray-600 font-mono break-all">{src}</p>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={label}
      onError={() => setFailed(true)}
      className="w-full rounded-lg border border-purple-100 dark:border-gray-700 shadow-sm"
    />
  );
}

interface UserGuidePanelProps {
  onClose: () => void;
}

export function UserGuidePanel({ onClose }: UserGuidePanelProps) {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const scrollTo = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Active-nav-item highlight while scrolling — the section whose top is
  // closest to (but still within) the content area's visible top "wins".
  // rootMargin trims the bottom 70% of the viewport so a section is only
  // considered active once it's actually near the top, not the instant any
  // sliver of it appears at the bottom.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target instanceof HTMLElement) setActiveId(visible[0].target.dataset.sectionId!);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    for (const id of SECTIONS.map((s) => s.id)) {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-4xl h-[85vh] bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-purple-100 dark:border-gray-700 flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Nav — sticky within its own column, not the whole panel, so it
            stays put while the right column scrolls. */}
        <div className="w-56 shrink-0 border-r border-purple-100 dark:border-gray-700 bg-purple-50/40 dark:bg-gray-900/40 flex flex-col">
          <div className="px-4 py-4 border-b border-purple-100 dark:border-gray-700">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">User Guide</h2>
          </div>
          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-left transition-colors cursor-pointer ${
                  activeId === s.id
                    ? 'bg-purple-600 text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-purple-100 dark:hover:bg-gray-700'
                }`}
              >
                <span className={activeId === s.id ? 'text-white' : 'text-purple-600 dark:text-purple-300'}>{s.icon}</span>
                {s.navLabel}
              </button>
            ))}
          </nav>
        </div>

        {/* Content — every section renders here, in order, in one scroll. */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-end px-5 py-3 border-b border-purple-100 dark:border-gray-700 shrink-0">
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <XLg size={14} />
            </button>
          </div>
          <div ref={contentRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-12">
            {SECTIONS.map((s) => (
              <div key={s.id} ref={(el) => { sectionRefs.current[s.id] = el; }} data-section-id={s.id}>
                <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1 inline-flex items-center gap-2">
                  <span className="text-purple-600 dark:text-purple-400">{s.icon}</span>
                  {s.title}
                </h3>
                {s.intro && <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{s.intro}</p>}
                <ol className="space-y-5 mt-4">
                  {s.steps.map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-purple-100 dark:bg-gray-700 text-purple-700 dark:text-purple-300 text-xs font-bold flex items-center justify-center mt-0.5">
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{step.text}</p>
                        {step.image && <div className="mt-2 max-w-md"><GuideImageSlot {...step.image} /></div>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
