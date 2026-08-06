import { useState } from 'react';

interface Slide {
  emoji: string;
  title: string;
  body: string;
}

// QA #1/#4/#6/#7 — "next-next sebelum masuk", clear Indonesian, teaches a
// total beginner to move/chat/meeting on their own, and calls out where
// MeetKai works differently from Gather/ZEP so an ex-user of those isn't
// confused looking for a feature that's just placed somewhere else here.
const SLIDES: Slide[] = [
  {
    emoji: '👋',
    title: 'Selamat datang di KaiSpace!',
    body: 'Ini kantor virtual — karaktermu bisa jalan-jalan, ngobrol, dan meeting langsung dari sini. Yuk kenalan sebentar, cuma beberapa langkah.',
  },
  {
    emoji: '🕹️',
    title: 'Gerak-gerak',
    body: 'Pakai tombol panah atau W A S D di keyboard untuk jalan. Karaktermu otomatis menghadap arah yang kamu tuju.',
  },
  {
    emoji: '🎥',
    title: 'Kamera & suara otomatis',
    body: 'Beda dari Zoom/Gather: kamu tidak perlu klik "join call". Begitu jalan mendekati orang lain, kamera dan mic kalian otomatis nyambung — makin jauh, makin pelan, persis dunia nyata.',
  },
  {
    emoji: '💬',
    title: 'Ngobrol lewat chat',
    body: 'Ada 2 tempat chat: bubble cepat di pojok kanan bawah (ikon 💬) untuk obrolan singkat, dan menu "Chat" (buka lewat ☰ di kiri) untuk riwayat lengkap serta pesan pribadi/grup.',
  },
  {
    emoji: '🟣',
    title: 'Meeting resmi',
    body: 'Jalan ke area/zona meeting (biasanya lantainya beda warna). Begitu masuk, tombol "Start Meeting" muncul otomatis di layar — tinggal klik.',
  },
  {
    emoji: '☰',
    title: 'Semua fitur ada di sini',
    body: 'Ikon garis tiga (☰) di kiri atas berisi semua fitur room: Kalender, Cuti, Absensi, Add Media (taruh gambar/video/catatan), Teleport, dan lainnya.',
  },
  {
    emoji: '🔀',
    title: 'Kalau kamu terbiasa pakai Gather/ZEP',
    body: 'Beberapa hal sengaja beda:\n• Video call nyambung otomatis saat deket, bukan klik "connect"\n• Taruh gambar/video/catatan lewat menu Add Media, bukan drag & drop ke peta\n• Meeting resmi lewat zona ungu + tombol Start Meeting, bukan link Zoom terpisah',
  },
  {
    emoji: '🚀',
    title: 'Siap jalan!',
    body: 'Segitu aja dasarnya — sisanya paling gampang dicoba langsung. Kalau lupa, panduan ini bisa dibuka lagi lewat menu ☰ → Panduan.',
  },
];

interface TutorialModalProps {
  onFinish: () => void;
  // QA #1 — "wajib tutorial bertahap": the first-run gate (App.tsx, before
  // <Game> ever mounts) is deliberately NOT dismissible — no skip, no close-X,
  // every slide has to be stepped through via "Lanjut" to reach "Mulai!".
  // The Sidebar's "Panduan" reopen (already-onboarded users checking
  // something again) passes this true to get a normal closable overlay.
  dismissible?: boolean;
}

export function TutorialModal({ onFinish, dismissible = false }: TutorialModalProps) {
  const [step, setStep] = useState(0);
  const isLast = step === SLIDES.length - 1;
  const slide = SLIDES[step];

  return (
    <div
      className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={dismissible ? onFinish : undefined}
    >
      <div
        className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-md p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {dismissible && (
          <button
            onClick={onFinish}
            title="Tutup"
            className="absolute top-3 right-3 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer"
          >
            ✕
          </button>
        )}

        <div className="text-5xl text-center mb-3">{slide.emoji}</div>
        <h2 className="text-lg font-bold text-center text-gray-900 dark:text-gray-100 mb-2">{slide.title}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 text-center leading-relaxed whitespace-pre-line">{slide.body}</p>

        <p className="text-center text-[11px] text-gray-400 dark:text-gray-500 mt-5 mb-1.5">
          Langkah {step + 1} dari {SLIDES.length}
        </p>
        <div className="flex items-center justify-center gap-1.5 mb-5">
          {SLIDES.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-purple-600' : 'w-1.5 bg-gray-200 dark:bg-gray-600'}`}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="px-4 py-2 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Kembali
            </button>
          )}
          <button
            onClick={() => (isLast ? onFinish() : setStep((s) => s + 1))}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white cursor-pointer"
          >
            {isLast ? 'Mulai!' : 'Lanjut'}
          </button>
        </div>
      </div>
    </div>
  );
}
