import { ReactNode, useEffect, useRef, useState } from 'react';
import { XLg, Joystick, CameraVideoFill, Grid3x3GapFill, ExclamationTriangleFill, CameraFill, Headset, ImageFill, PipFill, CalendarEvent, DoorOpenFill, ShieldLock, GearFill } from 'react-bootstrap-icons';

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
      { text: 'Gerak pakai tombol panah atau W A S D. Bisa juga klik langsung di peta — karaktermu otomatis jalan ke sana, mencari jalan sendiri tanpa nabrak meja/tembok.' },
      { text: 'Tahan Shift atau R sambil jalan untuk lari lebih cepat.' },
      { text: 'Tombol interaksi: Space (duduk di kursi terdekat / lompat), X (buka gambar-video-file di dekatmu), F (pakai teleport/pintu/objek interaktif terdekat), Z (colek orang terdekat).' },
      { text: 'Masuk room: klik kartu room-nya di Lobby. Keluar: klik ikon rumah di sidebar kiri, atau tombol merah di toolbar bawah — kamu tetap login, cuma balik ke daftar Space.' },
    ],
  },
  {
    id: 'audio-video',
    navLabel: 'Audio/Video Guide',
    title: 'Audio/Video Guide',
    icon: <CameraVideoFill size={15} />,
    steps: [
      { text: 'Mic: klik tombol mikrofon di toolbar bawah, atau tekan M.', image: { src: '/assets/img/guide/av-mic.jpg', label: 'Mute/unmute mic' } },
      { text: 'Kamera: klik tombol kamera, atau tekan V.', image: { src: '/assets/img/guide/av-camera.jpg', label: 'Nyala/mati kamera' } },
      { text: 'Suara otomatis mengeras/pelan sesuai jarak avatar (proximity) — tidak perlu klik "join call" seperti Zoom.' },
      { text: 'Share screen: klik tombol share-screen di toolbar bawah untuk mulai, klik lagi untuk berhenti.', image: { src: '/assets/img/guide/av-share.jpg', label: 'Share screen' } },
      { text: 'Ganti mic/speaker/kamera yang dipakai: klik ikon titik-tiga (⋮) di toolbar bawah.', image: { src: '/assets/img/guide/av-device.jpg', label: 'Pilih device' } },
    ],
  },
  {
    id: 'app-features',
    navLabel: 'App User Guide',
    title: 'App User Guide',
    icon: <Grid3x3GapFill size={15} />,
    intro: 'Ringkasan fitur-fitur sosial utama KaiSpace — fitur produktivitas (Kalender, Absensi, dll), menu admin, dan pengaturan akun masing-masing punya bagian sendiri di bawah.',
    steps: [
      { text: 'Ruang: bikin Space baru (khusus akun admin) lewat tombol "+ Create Space" di Lobby, atau join room lewat kartu / tombol "Join with Code".', image: { src: '/assets/img/guide/app-ruang.jpg', label: 'Buat/join room' } },
      { text: 'Chat: ada channel bersama (termasuk channel privat otomatis untuk ruangan yang dikunci), DM 1-on-1, @mention, kirim file/gambar, dan pin pesan jadi pengumuman (khusus admin) — pesan yang dipin juga bisa dicek siapa saja yang sudah "Dibaca oleh"-nya.' },
      { text: 'Mode Bubble: centang "Bubble" di pojok kanan-atas panel Chat untuk ganti cara kirim pesan — bukan masuk ke channel, tapi jadi gelembung ucapan mengambang di atas avatarmu yang cuma kelihatan orang di sekitarmu (proximity), sama seperti ngobrol langsung di dunia nyata.', image: { src: '/assets/img/guide/app-bubble.jpg', label: 'Mode Bubble' } },
      { text: 'Peserta: buka panel Peserta lewat ikon orang di toolbar bawah — ada kolom pencarian nama, dan menu titik-tiga di sebelah tiap orang untuk "Temukan" (arahkan kamera ke dia), "Ikuti", "Panggil ke sini" (Summon), "Colek (sadarkan)", "Bisukan", "Kirim pesan", dan "Laporkan".', image: { src: '/assets/img/guide/app-peserta.jpg', label: 'Panel Peserta' } },
      { text: 'Meeting View: klik ikon grid untuk masuk tampilan video-call layar penuh. Klik tile siapa pun untuk menyorotnya jadi tampilan utama, lalu klik "Lepas" di pojok kanan-atas tile itu untuk kembali ke tampilan grid biasa.', image: { src: '/assets/img/guide/app-meeting.jpg', label: 'Meeting View' } },
      { text: 'Booking CEO: tekan G di mana pun di dalam room untuk ajukan jadwal ngobrol dengan CEO. Atur jam "Mulai" dan "Selesai", isi "Keperluan" (opsional), lalu klik "Ajukan booking" — statusnya "menunggu persetujuan CEO" sampai disetujui, dan begitu jamnya tiba kamu otomatis masuk ke ruangannya.', image: { src: '/assets/img/guide/app-booking.jpg', label: 'Booking CEO' } },
      { text: 'My Seat: duduk dulu di kursi mana pun (tombol/tombol Space), lalu klik tombol "🪑 Assign as My Seat" yang muncul di atas toolbar — kursi itu jadi kursi tetapmu, otomatis kamu duduk di sana lagi setiap kali masuk room ini, bahkan setelah logout atau server sempat di-restart, karena disimpan di database, bukan cuma di sesi saat itu. Duduk lagi di kursi yang sama lalu klik "Unassign My Seat" untuk membatalkannya.', image: { src: '/assets/img/guide/app-myseat.jpg', label: 'My Seat' } },
      { text: 'Minimap: peta kecil di pojok kanan-bawah layar menampilkan denah keseluruhan ruangan — klik di titik mana pun pada minimap untuk langsung teleport ke lokasi itu.', image: { src: '/assets/img/guide/app-minimap.jpg', label: 'Minimap' } },
      { text: 'Reaksi & angkat tangan: klik ikon senyum di toolbar bawah untuk kirim reaksi cepat (jempol ke atas/bawah, senyum, hati, lampu ide, wajah datar, bulan sabit, api). Tekan H atau klik ikon tangan untuk angkat tangan menandai kamu mau bicara — ikonnya muncul di avatar dan video tile-mu disertai suara notifikasi ke peserta lain, tekan H lagi untuk menurunkannya.', image: { src: '/assets/img/guide/app-reaksi.jpg', label: 'Reaksi & angkat tangan' } },
    ],
  },
  {
    id: 'room-tools',
    navLabel: 'Fitur Room Lainnya',
    title: 'Fitur Lain di Menu Room',
    icon: <PipFill size={15} />,
    intro: 'Klik ikon ☰ ("Room Features") paling atas di sidebar kiri untuk buka menu ini — pusat akses ke berbagai fitur tambahan berikut.',
    steps: [
      { text: 'Mini Mode: buka jendela kamera kamu sendiri yang mengambang dan bisa digeser ke mana saja (biasanya nangkring di pojok kanan-bawah), lengkap dengan tombol mic/kamera dan ikon perbesar/tutup sendiri — kamu bisa terus jalan-jalan atau kerja di panel lain sambil kameramu tetap kelihatan.', image: { src: '/assets/img/guide/room-minimode.jpg', label: 'Mini Mode' } },
      { text: 'Simplify: sembunyikan seluruh sidebar kiri jadi cuma satu ikon mata kecil di pojok kiri-atas, buat tampilan yang lebih bersih (misalnya sebelum ambil screenshot). Klik ikon mata itu lagi untuk memunculkan semua UI kembali.', image: { src: '/assets/img/guide/room-simplify.jpg', label: 'Simplify' } },
      { text: 'Teleport: pilih salah satu nama zona/ruangan dari daftar (misalnya nama tim, ruang meeting, atau area seperti "Focus Mode"/"Lounge") — karaktermu langsung dipindah ke sana tanpa perlu jalan manual.', image: { src: '/assets/img/guide/room-teleport.jpg', label: 'Teleport' } },
      { text: 'Add Media: tempel berbagai jenis konten ke dalam map — "Screenshot" (unduh gambar peta tanpa ikut ter-foto UI/chat/sidebar), "Image" (upload gambar), "Whiteboard" (papan tulis bersama), "File" (upload dokumen), "Note" (catatan tempel), atau tempel link YouTube di kolom yang tersedia untuk menampilkan videonya langsung di room.', image: { src: '/assets/img/guide/room-addmedia.jpg', label: 'Add Media' } },
      { text: 'Soundboard: klik ikon speaker ungu di pojok kiri-atas layar, lalu klik salah satu tombol suara singkat (efek suara/reaksi) — otomatis terdengar oleh orang di sekitarmu, sama seperti audio biasa.', image: { src: '/assets/img/guide/room-soundboard.jpg', label: 'Soundboard' } },
      { text: 'Recent Activity (khusus manajer): klik ikon jam di sebelah Soundboard untuk lihat log kejadian terbaru di room, misalnya siapa yang baru join/keluar atau perubahan mode darurat pintu.', image: { src: '/assets/img/guide/room-activity.jpg', label: 'Recent Activity' } },
      { text: 'Customize Avatar: klik ikon pensil untuk ubah tampilan karaktermu — pilih "Build Character" untuk atur Body, Eyes, Outfit, Hairstyle, dan Accessory satu per satu, atau "Quick Pick" untuk pilih preset cepat. Ganti nama tampilan lewat kolom "Display Name" (maksimal 20 karakter).', image: { src: '/assets/img/guide/room-avatar.jpg', label: 'Customize Avatar' } },
      { text: 'Status: klik ikon bendera untuk pilih status kerjamu — Available, WFO, WFH, WFA, Cuti, Focus, In a meeting, Lunch, Break, atau Away.', image: { src: '/assets/img/guide/room-status.jpg', label: 'Status' } },
    ],
  },
  {
    id: 'productivity',
    navLabel: 'Produktivitas',
    title: 'Produktivitas',
    icon: <CalendarEvent size={15} />,
    intro: 'Menu produktivitas di Room Features — kalender, absensi & cuti, dan analitik pribadi.',
    steps: [
      { text: 'Kalender: lihat jadwal dengan tampilan "Hari / Minggu / Bulan / Agenda", klik "+ Acara" untuk menambah acara baru, atau "+ Kalender baru" di panel kiri untuk bikin kalender tambahan.', image: { src: '/assets/img/guide/prod-kalender.jpg', label: 'Kalender' } },
      { text: 'Absensi: klik "Clock in" saat mulai kerja dan "Clock out" saat selesai — jam masuk/keluar, status (tepat waktu/terlambat), dan total jam kerja tercatat otomatis. Tab "Cuti" di panel yang sama dipakai untuk mengajukan cuti (pilih jenis cuti, tanggal mulai/selesai, dan alasan).', image: { src: '/assets/img/guide/prod-absensi.jpg', label: 'Absensi' } },
      { text: 'Analitik Saya: lihat statistik produktivitas pribadimu — jam hadir, focus time, waktu meeting, task selesai, connections, skor "Vibe pribadi", timeline status harian, dan distribusi waktu. Pilih rentang "Harian/Mingguan/Bulanan/Kustom" dan klik "Ekspor Excel" kalau perlu file-nya. Menu ini terbuka untuk semua karyawan, bukan cuma admin.', image: { src: '/assets/img/guide/prod-analitik.jpg', label: 'Analitik Saya' } },
    ],
  },
  {
    id: 'room-admin',
    navLabel: 'Admin Room',
    title: 'Menu Khusus Admin Room',
    icon: <DoorOpenFill size={15} />,
    intro: 'Baris-baris menu berikut di Room Features cuma muncul untuk admin room ini (beda dari Konsol Admin, yang levelnya workspace — lihat bagian selanjutnya).',
    steps: [
      { text: 'Buat Guest Link: klik "Buat Guest Link", lalu jawab 3 dialog berurutan — berapa jam link berlaku (kosongkan untuk tanpa batas waktu), apakah link cuma sekali pakai, dan password link (kosongkan supaya dibuatkan otomatis). Link yang jadi siap dibagikan ke tamu tanpa akun.', image: { src: '/assets/img/guide/radm-guestlink.jpg', label: 'Buat Guest Link' } },
      { text: 'Cabut Guest Link Terakhir: klik untuk langsung mencabut guest link yang PALING TERAKHIR dibuat — tamu yang sedang masuk lewat link itu otomatis dikeluarkan. Ini cuma mencabut satu link terakhir, bukan semua link yang pernah dibuat.', image: { src: '/assets/img/guide/radm-cabutlink.jpg', label: 'Cabut Guest Link Terakhir' } },
      { text: 'Buka Semua Pintu (Darurat): membuka paksa semua pintu berpassword di room untuk semua orang, ditandai banner merah "Mode darurat: semua pintu terbuka". Klik baris menu yang sama lagi (sekarang berubah jadi "Matikan Mode Darurat Pintu") untuk mengunci ulang seperti biasa.', image: { src: '/assets/img/guide/radm-emergency.jpg', label: 'Buka Semua Pintu (Darurat)' } },
      { text: 'Broadcast: ketik pesan di kolom yang muncul lalu klik OK — langsung terkirim ke semua orang yang sedang ada di room ini.', image: { src: '/assets/img/guide/radm-broadcast.jpg', label: 'Broadcast' } },
      { text: 'Edit Room: membuka tab baru berisi Room Editor untuk mengubah tata letak room (lantai, dinding, objek), dengan alat gambar Stamp/Eraser/Select/Hand/Copy dan ukuran kuas 1x1/3x3/5x5 — perubahan tersimpan otomatis, ditandai indikator "Tersimpan otomatis ✓" di toolbar.', image: { src: '/assets/img/guide/radm-editroom.jpg', label: 'Edit Room' } },
      { text: 'Permintaan Bergabung: kalau room diset butuh persetujuan admin, badge angka muncul di baris menu ini menandakan berapa orang menunggu. Klik untuk lihat daftar nama dan email mereka, lalu "Setujui" atau "Tolak" satu per satu.', image: { src: '/assets/img/guide/radm-joinreq.jpg', label: 'Permintaan Bergabung' } },
    ],
  },
  {
    id: 'admin-console',
    navLabel: 'Konsol Admin',
    title: 'Konsol Admin',
    icon: <ShieldLock size={15} />,
    intro: 'Panel khusus admin WORKSPACE (bukan cuma admin satu room) untuk kelola anggota, persetujuan akses, laporan absensi, analitik produktivitas seluruh perusahaan, ruang meeting, kebijakan, audit log, dan backup.',
    steps: [
      { text: 'Buka lewat ikon ☰ ("Room Features") di sidebar kiri, lalu klik "Konsol Admin" — item ini bertanda ikon perisai dan cuma muncul kalau role workspace-mu Admin. Tutup kapan saja lewat tombol X di kiri atas atau tekan Esc.', image: { src: '/assets/img/guide/admin-open.jpg', label: 'Buka Konsol Admin' } },
      { text: 'Konsol Admin punya 8 tab: Anggota, Persetujuan, Laporan, Analitik, Ruang & Kalender, Kebijakan, Audit log, dan Backup.', image: { src: '/assets/img/guide/admin-tabs.jpg', label: '8 tab Konsol Admin' } },
      { text: 'Tab Anggota: tabel semua anggota workspace (nama, email, dropdown Peran "Admin"/"Anggota", Departemen, Manajer, tanggal Bergabung, tombol Nonaktifkan/Aktifkan) — apa pun yang diubah langsung tersimpan otomatis. Klik "Undang anggota" untuk mengundang orang baru: isi email, pilih peran, klik "Buat undangan" — sistem membuatkan link undangan berlaku 7 hari yang kamu salin dan kirim sendiri.', image: { src: '/assets/img/guide/admin-anggota.jpg', label: 'Tab Anggota' } },
      { text: 'Tab Persetujuan bagian atas: antrean "Permintaan bergabung" dari semua room di workspace, dengan tombol Setujui/Tolak per orang. Centang "Room yang perlu persetujuan" pada room tertentu supaya siapa pun yang pakai link undangannya masuk antrean ini dulu.', image: { src: '/assets/img/guide/admin-persetujuan1.jpg', label: 'Tab Persetujuan' } },
      { text: 'Masih di tab Persetujuan: "Room dibatasi (akses khusus)" adalah mode lebih ketat untuk ruang sensitif (misalnya ruang CEO/klien) — hanya orang yang diberi akses lewat "Kelola akses" (cari nama, pilih role staff/admin, klik "Beri akses") yang bisa masuk sama sekali. Room dibatasi juga bisa punya antrean "Ngobrol dengan CEO" — centang "Aktifkan antrean" di "Kelola akses" untuk menyalakannya, lalu pantau siapa yang menunggu/dipanggil/sedang di dalam.', image: { src: '/assets/img/guide/admin-persetujuan2.jpg', label: 'Room dibatasi & antrean CEO' } },
      { text: 'Tab Laporan: laporan absensi. Pilih rentang tanggal dan departemen, klik "Ekspor CSV" untuk mengunduh. "Rekap per orang" merangkum hari hadir/telat/jam kerja/lembur, "Rincian" menampilkan tiap hari (jam masuk-keluar-status). Setiap kali laporan ini dibuka atau diekspor, otomatis tercatat di Audit log.', image: { src: '/assets/img/guide/admin-laporan.jpg', label: 'Tab Laporan' } },
      { text: 'Tab Analitik (Productivity Analytics): 3 sub-tab — "Individu" (data diri sendiri), "Team" (data anak buah langsung), dan "All Kaitech" (data seluruh perusahaan). Pilih periode (Harian/Mingguan/Bulanan/Kustom) dan klik "Ekspor Excel" kalau perlu file-nya. Yang ditampilkan: kartu ringkasan (Tim aktif, Utilization, Delivery on-time, Rata-rata focus, Scheduling saved, Peak concurrent, ROI estimasi), grafik Daily Active Users, Heatmap kehadiran per jam per hari, Utilization per departemen, dan tren delivery on-time.', image: { src: '/assets/img/guide/admin-analitik.jpg', label: 'Tab Analitik' } },
      { text: 'Tab Ruang & Kalender: klik "+ Ruang baru" untuk membuat ruang meeting (nama, kapasitas, lokasi opsional, siapa boleh booking). Klik "Lihat booking" pada satu ruang untuk melihat jadwalnya 30 hari ke depan, lalu "Batalkan" kalau perlu membatalkan booking orang lain (boleh isi alasan) — pemiliknya otomatis diberi tahu dan tindakan ini tercatat di audit log.', image: { src: '/assets/img/guide/admin-ruangkalender.jpg', label: 'Tab Ruang & Kalender' } },
      { text: 'Tab Kebijakan: atur aturan workspace lewat toggle — "Izinkan link berbagi publik" dan "Izinkan ekspor CSV" (Base), "Izinkan link berbagi publik" dan "Wajibkan password di link dokumen" (Docs), serta "Batas usia link berbagi (hari)" (kosongkan untuk tanpa batas — link lama otomatis dipangkas server begitu lewat batas ini).', image: { src: '/assets/img/guide/admin-kebijakan.jpg', label: 'Tab Kebijakan' } },
      { text: 'Tab Audit log: mencatat setiap tindakan admin, bisa difilter berdasarkan pelaku, subjek, jenis aksi, atau rentang tanggal — tiap baris menampilkan perubahan "sebelum → sesudah" secara rinci. Log ini cuma bisa bertambah, tidak pernah bisa diedit atau dihapus siapa pun, termasuk admin.', image: { src: '/assets/img/guide/admin-auditlog.jpg', label: 'Tab Audit log' } },
      { text: 'Tab Backup: satu tombol, "Unduh backup" — mengunduh satu file JSON berisi semua catatan ruang (notes), Minutes of Meeting (MoM), dan data absensi langsung ke komputermu (tidak disimpan di server). Pengumuman (notice) dan lokasi GPS absensi sengaja tidak ikut dicadangkan.', image: { src: '/assets/img/guide/admin-backup.jpg', label: 'Tab Backup' } },
      { text: 'Catatan: menu "Analitik Saya" yang juga muncul di daftar Room Features BUKAN bagian dari Konsol Admin — itu versi mandiri dari tab Individu di atas, dan bisa dibuka semua karyawan (bukan cuma admin) untuk melihat produktivitas dirinya sendiri.', image: { src: '/assets/img/guide/admin-myanalytics-menu.jpg', label: 'Menu Analitik Saya di Room Features' } },
    ],
  },
  {
    id: 'settings',
    navLabel: 'Pengaturan Akun',
    title: 'Pengaturan Akun',
    icon: <GearFill size={15} />,
    steps: [
      { text: 'Klik ikon gear (⚙) di sidebar kiri-bawah untuk buka Settings. Bagian Notifikasi punya toggle umum "Aktifkan notifikasi browser" dan "Suara notifikasi", plus toggle per jenis kejadian: Pesan chat, Disebut (@mention), Disenggol (Nudge), Dicolek (Slap), dan Angkat tangan. Pengaturan ini tersimpan ke akunmu, jadi tetap kepakai walau login dari perangkat lain.' },
      { text: 'Klik ikon matahari/bulan di sidebar kiri-bawah untuk ganti tampilan terang/gelap.' },
      { text: 'Klik ikon mata di pojok kanan-atas layar (sebelah ikon Meeting View) untuk sembunyikan sementara strip video peserta di sisi kanan — kamera dan mic tetap menyala, cuma tampilan tile-nya yang hilang, digantikan badge kecil jumlah peserta yang video-nya aktif. Klik lagi untuk memunculkan tile-nya.' },
      { text: 'Ikon rumah di sidebar kiri-bawah ("Kembali ke Daftar Room") cuma keluar dari room ini — kamu tetap login, balik ke Lobby. Beda dengan ikon pintu-keluar paling bawah ("Logout"), yang benar-benar keluar dari akunmu.' },
    ],
  },
  {
    id: 'troubleshooting',
    navLabel: 'Problem Solving',
    title: 'Problem Solving Checklist',
    icon: <ExclamationTriangleFill size={15} />,
    steps: [
      { text: 'Mic tidak bunyi → cek izin mikrofon di pengaturan browser, cek device yang aktif lewat menu ⋮ di toolbar, pastikan tombol mic tidak sedang merah (mute).', image: { src: '/assets/img/guide/trouble-mic.jpg', label: 'Mic tidak bunyi' } },
      { text: 'Kamera hitam / tidak muncul → cek izin kamera di browser, cek pilihan device lewat menu ⋮.', image: { src: '/assets/img/guide/trouble-camera.jpg', label: 'Kamera hitam' } },
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
      { text: 'Buka menu ☰ (Room Features) di sidebar kiri, lalu klik "Add Media".', image: { src: '/assets/img/guide/screenshot-addmedia.jpg', label: 'Buka Add Media' } },
      { text: 'Klik tombol "Screenshot" — otomatis mengunduh gambar peta (tanpa ikut ter-foto UI/chat/sidebar) ke komputermu.', image: { src: '/assets/img/guide/screenshot-klik.jpg', label: 'Klik tombol Screenshot' } },
    ],
  },
  {
    id: 'cs-center',
    navLabel: 'Customer Service',
    title: 'Customer Service Center',
    icon: <Headset size={15} />,
    steps: [
      { text: 'Klik tombol "Chat" (ikon gelembung pesan) di pojok kanan-bawah layar untuk buka panel Chat, lalu klik tab "CS" (ikon headset) di bagian atas panel untuk masuk ke Customer Service Center.', image: { src: '/assets/img/guide/cs-tanya.jpg', label: 'Buka tab CS' } },
      { text: 'Tanya seputar cara pakai KaiSpace — bot akan coba jawab otomatis.' },
      { text: 'Sudah yakin butuh tim manusia? Tidak perlu nunggu bot kebingungan dulu — langsung ketik "admin" di kolom chat untuk diteruskan ke tim CS.' },
      { text: 'Kalau bot belum punya jawabannya, klik "Hubungi admin" yang muncul untuk diteruskan ke tim CS.', image: { src: '/assets/img/guide/cs-hubungi.jpg', label: 'Hubungi admin' } },
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
