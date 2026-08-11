// Customer Service bot FAQ — simple keyword matching, NOT an LLM (see
// routes/cs.ts's matchFaq). This seed list is PLACEHOLDER content adapted
// from docs/KB-FAQ-KaiSpace.docx (the same accuracy-checked source) just so
// Tahap 2 is demonstrably functional — the real list is meant to be
// supplied/edited by the product owner, not treated as final copy.
export interface CsFaqEntry {
  keywords: string[];
  question: string;
  answer: string;
}

export const CS_FAQ: CsFaqEntry[] = [
  {
    keywords: ['jalan', 'gerak', 'bergerak', 'wasd', 'lari', 'navigasi'],
    question: 'Gimana cara jalan/gerak di KaiSpace?',
    answer: 'Pakai tombol W A S D atau tombol panah untuk jalan. Tahan Shift atau R sambil bergerak untuk lari. Bisa juga klik di peta untuk jalan otomatis ke sana.',
  },
  {
    keywords: ['mic', 'mikrofon', 'mute', 'unmute'],
    question: 'Gimana cara mute/unmute mic?',
    answer: 'Klik tombol mikrofon di toolbar bawah, atau tekan tombol M kapan saja. Ungu solid = mic aktif, ikon merah = mic mati.',
  },
  {
    keywords: ['kamera', 'camera', 'video mati', 'video nyala'],
    question: 'Gimana cara nyalain/matiin kamera?',
    answer: 'Klik tombol kamera di toolbar bawah, atau tekan tombol V. Kalau kamera mati, tile-mu tetap tampil foto profil/inisial, bukan kotak hitam.',
  },
  {
    keywords: ['share screen', 'share layar', 'berbagi layar', 'presentasi'],
    question: 'Gimana cara share screen?',
    answer: 'Klik tombol share-screen di toolbar bawah untuk mulai, klik lagi untuk berhenti. Tidak ada shortcut keyboard untuk ini.',
  },
  {
    keywords: ['chat', 'pesan', 'dm', 'kirim pesan'],
    question: 'Gimana cara chat/kirim pesan?',
    answer: 'Klik tombol Chat di pojok kanan-bawah layar. Ada channel bersama, dan bisa juga DM 1-on-1 lewat menu titik-tiga di panel Peserta.',
  },
  {
    keywords: ['buat room', 'buat space', 'create space', 'bikin ruangan'],
    question: 'Gimana cara bikin Space/room baru?',
    answer: 'Tombol "+ Create Space" di Lobby hanya muncul untuk akun admin. Kalau kamu tidak melihatnya, hubungi admin workspace-mu untuk dijadikan admin atau minta dibuatkan room.',
  },
  {
    keywords: ['guest', 'tamu', 'link undangan', 'masuk tanpa akun'],
    question: 'Gimana cara masuk sebagai tamu (guest)?',
    answer: 'Buka link undangan yang diberikan admin, isi nama dan password link-nya di halaman "Masuk sebagai Tamu", lalu tunggu admin menyetujui permintaan masukmu.',
  },
  {
    keywords: ['booking ceo', 'ngobrol dengan ceo', 'jadwal ceo', 'tombol g'],
    question: 'Gimana cara booking ngobrol dengan CEO?',
    answer: 'Tekan tombol G di mana pun di dalam room untuk buka form booking, pilih jam mulai-selesai, lalu ajukan. Kamu akan otomatis masuk ruangan CEO begitu jamnya tiba, setelah disetujui.',
  },
  {
    keywords: ['lupa password', 'tidak bisa login', 'gagal login'],
    question: 'Tidak bisa login / lupa password, gimana?',
    answer: 'Untuk saat ini, hubungi admin workspace kamu langsung untuk reset akses — belum ada fitur reset password mandiri di KaiSpace.',
  },
];

// Very small, deliberately non-fuzzy matcher: lowercases both sides and
// scores each entry by how many of its keywords appear as a substring of
// the user's message, picking the highest-scoring entry. No match at all
// (score 0 for every entry) returns null so the caller can offer the
// "Hubungi admin" fallback instead of guessing.
export function matchFaq(userText: string): CsFaqEntry | null {
  const normalized = userText.toLowerCase();
  let best: CsFaqEntry | null = null;
  let bestScore = 0;
  for (const entry of CS_FAQ) {
    const score = entry.keywords.reduce((acc, kw) => acc + (normalized.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore > 0 ? best : null;
}
