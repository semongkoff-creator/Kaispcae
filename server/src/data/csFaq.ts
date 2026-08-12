// Customer Service bot FAQ — simple keyword matching, NOT an LLM (see
// routes/cs.ts's matchFaq). Sourced directly from docs/KB-FAQ-KaiSpace.docx
// (53 Q&A across 10 categories, itself written by walking the actual app
// code feature-by-feature — not guesses). This IS the bot's knowledge base;
// there is no other backing store or external service behind it anymore
// (the earlier n8n/WAHA relay was dropped — see routes/cs.ts). If KaiSpace's
// features change, re-check the docx and this file together so they don't
// drift apart.
export interface CsFaqEntry {
  keywords: string[];
  question: string;
  answer: string;
}

export const CS_FAQ: CsFaqEntry[] = [
  // Gerak & Navigasi
  {
    keywords: ['jalan', 'gerak', 'bergerak', 'wasd', 'arrow', 'panah', 'navigasi', 'joystick'],
    question: 'Gimana cara jalan di KaiSpace?',
    answer: 'Pakai tombol W A S D atau tombol panah (Arrow keys) — keduanya bisa dipakai bebas, tidak harus salah satu.\nDi HP/tablet, muncul joystick sentuh di pojok kiri bawah layar sebagai gantinya.',
  },
  {
    keywords: ['lari', 'lebih cepat', 'shift', 'kecepatan', 'run'],
    question: 'Ada cara lari/lebih cepat?',
    answer: 'Ada. Tahan Shift atau R sambil bergerak untuk lari (sekitar 1.5x kecepatan jalan biasa). Tombol ini tidak berpengaruh kalau tidak sedang menekan arah gerak.\nDi HP, ada tombol "Run" (ikon petir) khusus.',
  },
  {
    keywords: ['klik peta', 'jalan otomatis', 'klik map', 'auto jalan', 'jalan sendiri'],
    question: 'Bisa klik di peta biar jalan otomatis ke sana?',
    answer: 'Bisa. Klik titik mana saja yang bisa dilewati di peta, karakter akan otomatis jalan ke sana — dan otomatis muter kalau ada meja/tembok/orang lain di jalan (bukan cuma jalan lurus lalu nyangkut).',
  },
  {
    keywords: ['interaksi', 'duduk', 'kursi', 'tombol x', 'tombol f', 'tombol z', 'colek', 'senggol', 'portal', 'teleport', 'whiteboard', 'lompat'],
    question: 'Gimana cara berinteraksi dengan objek atau orang lain?',
    answer: 'Space — duduk di kursi terdekat (atau berdiri lagi kalau sudah duduk), atau lompat kalau tidak ada kursi di dekat situ.\nX — buka objek media terdekat (gambar, video YouTube, whiteboard, file) saat berdiri di sampingnya.\nF — tombol "interaksi" serba-guna: pakai portal teleport terdekat, trigger Objek Interaktif terdekat, atau buka form password pintu — yang paling dekat.\nZ — "colek/senggol" orang terdekat: efek kecil (avatar bergetar) untuk menarik perhatian mereka.\nCukup jalan mendekat ke seseorang otomatis membawa mereka masuk ke jangkauan audio/video proximity kamu.',
  },
  {
    keywords: ['keluar room', 'balik ke lobby', 'daftar space', 'ikon rumah', 'keluar ruangan', 'back to room'],
    question: 'Gimana cara keluar dari room dan balik ke daftar Space?',
    answer: 'Klik ikon rumah di sidebar kiri ("Back to room list"), atau tombol merah (gagang telepon) di toolbar bawah — dua-duanya sama-sama membawa balik ke daftar Space tanpa logout dari akun.',
  },

  // Mic & Audio
  {
    keywords: ['mute', 'unmute', 'mic', 'mikrofon', 'tombol m'],
    question: 'Gimana cara mute/unmute mic?',
    answer: 'Klik tombol mikrofon di toolbar bawah, atau tekan tombol M kapan saja (nonaktif kalau lagi ngetik di kolom teks).\nTombol jadi ungu solid saat mic aktif; putih/kaca dengan ikon merah + cincin merah berdenyut saat mic mati.',
  },
  {
    keywords: ['suara kecil besar', 'proximity', 'jarak suara', 'suara berubah', 'volume otomatis'],
    question: 'Kenapa suara orang lain berubah kecil-besar sendiri? Itu proximity audio?',
    answer: 'Betul, ini otomatis (bukan bug). Makin dekat avatar orang itu ke kamu, suaranya makin jelas/keras; makin jauh, makin pelan sampai hilang total.\nDuduk satu meja dengan seseorang, atau berada di zone meeting yang sama, membuat suara tetap penuh terlepas dari jarak persis di layar.',
  },
  {
    keywords: ['volume satu orang', 'volume orang tertentu', 'slider volume', 'kecilkan volume', 'volume sendiri'],
    question: 'Bisa atur volume satu orang tertentu (buat aku sendiri saja)?',
    answer: 'Bisa. Tiap tile video orang lain punya slider volume sendiri — muncul saat kursor diarahkan ke tile itu (hover), atau otomatis tetap kelihatan kalau volumenya sudah kamu kecilkan.\nIni cuma mengubah apa yang KAMU dengar — tidak mematikan mic orang itu dan tidak berpengaruh ke orang lain di room.',
  },
  {
    keywords: ['pilih mic', 'pilih speaker', 'pilih kamera', 'ganti device', 'ganti perangkat', 'titik tiga toolbar', 'device menu'],
    question: 'Bisa pilih mic/speaker/kamera mana yang dipakai?',
    answer: 'Bisa. Klik tombol titik-tiga (⋮) di toolbar bawah — muncul daftar Mikrofon, Speaker, dan Kamera yang tersedia dengan tanda centang di perangkat yang aktif. Pilih yang lain, langsung ganti tanpa perlu matikan mic/kamera dulu.',
  },

  // Kamera & Video
  {
    keywords: ['kamera', 'camera', 'nyalain kamera', 'matiin kamera', 'tombol v', 'video mati', 'video nyala'],
    question: 'Gimana cara nyalain/matiin kamera?',
    answer: 'Klik tombol kamera di toolbar bawah, atau tekan tombol V (nonaktif saat sedang ngetik).\nUngu solid = kamera nyala; putih/kaca dengan ikon merah = kamera mati.',
  },
  {
    keywords: ['kamera mati tampil', 'tile kosong', 'foto profil', 'inisial', 'kotak hitam'],
    question: 'Kalau kamera dimatikan, tile-nya nampilin apa?',
    answer: 'Foto profil (kalau sudah upload satu), atau kalau belum, lingkaran warna dengan inisial nama asli — tidak pernah kotak hitam kosong.',
  },

  // Share Screen
  {
    keywords: ['share screen', 'share layar', 'berbagi layar', 'presentasi', 'mulai share'],
    question: 'Gimana cara mulai/berhenti share layar?',
    answer: 'Klik tombol share-screen di toolbar bawah untuk mulai; klik lagi untuk berhenti. Sengaja tidak ada shortcut keyboard untuk ini (semua huruf sudah dipakai WASD).\nSaat sedang share, tombolnya jadi ungu solid dengan cincin berdenyut.',
  },
  {
    keywords: ['share screen hp', 'tidak ada tombol share', 'share layar hp', 'mobile share', 'hp tidak ada'],
    question: 'Kenapa tombol share screen tidak muncul di HP-ku?',
    answer: 'Tombol ini otomatis disembunyikan di perangkat/browser yang memang tidak mendukung fitur share-screen (kebanyakan browser mobile) — supaya tidak muncul tombol yang ujung-ujungnya gagal saat ditekan.',
  },
  {
    keywords: ['lihat share', 'layar penuh', 'zoom share', 'perbesar layar', 'panel share', 'thumbnail share'],
    question: 'Kalau ada yang share layar, gimana orang lain lihatnya? Bisa diperbesar?',
    answer: 'Layar yang di-share muncul sebagai panel mengambang sendiri (terpisah dari tile kamera), nempel di bagian atas layar. Kalau belum ada yang share lain, langsung tampil di panel besar; kalau sudah ada yang share duluan, share berikutnya jadi thumbnail kecil yang bisa diklik untuk pindah ke panel besar.\nAda juga tombol "Layar Penuh" untuk memperbesar hampir ke seluruh layar, plus bisa zoom/geser pakai scroll atau drag — ini cuma tampilan lokal masing-masing orang, tidak mengubah apa yang dilihat orang lain.',
  },

  // Chat
  {
    keywords: ['buka chat', 'panel chat', 'tombol chat'],
    question: 'Gimana cara buka panel chat?',
    answer: 'Klik tombol "Chat" di pojok kanan-bawah layar. Ada badge merah dengan angka kalau ada pesan belum dibaca.',
  },
  {
    keywords: ['channel chat', 'channel default', 'general channel', 'tab channel'],
    question: 'Ada channel chat? Ada channel default yang semua orang lihat?',
    answer: 'Ada. Channel tampil sebagai tab "#nama" di bagian atas panel chat, dipakai bareng semua orang di room (bukan daftar pribadi). Ada satu channel default (mis. "#general") yang otomatis terbuka saat pertama kali masuk room.',
  },
  {
    keywords: ['bikin channel', 'buat channel', 'channel baru', 'tambah channel'],
    question: 'Siapa yang bisa bikin channel baru?',
    answer: 'Hanya admin room. Ada tombol "+" di samping tab channel (cuma kelihatan buat admin) untuk bikin channel baru.',
  },
  {
    keywords: ['chat privat', 'private zone', 'say nearby', 'bubble', 'chat deket', 'chat dekat'],
    question: 'Ada chat yang cuma kedengeran orang yang deket denganku?',
    answer: 'Ada dua fitur berbeda untuk ini:\n1) Chat privat per-zone: saat berdiri di dalam zone tertentu (mis. ruang privat), tab "Private" otomatis muncul di panel chat — pesan di sana cuma sampai ke orang yang SEDANG ada di zone yang sama, dan tidak pernah tersimpan (hilang begitu tidak ada yang lihat lagi).\n2) "Say nearby" (checkbox "Bubble" di kolom chat): pesan tidak masuk log chat sama sekali, tapi muncul sebagai bubble mengambang di atas avatar kamu selama ±4 detik, kelihatan oleh siapa saja yang bisa lihat avatarmu.',
  },
  {
    keywords: ['dm', 'pesan pribadi', 'chat pribadi', 'kirim pesan pribadi', 'japri', 'one on one'],
    question: 'Bisa kirim pesan pribadi (DM) ke satu orang?',
    answer: 'Bisa, untuk akun terdaftar (bukan tamu). Buka panel Peserta (People), klik menu titik-tiga di baris orang yang dituju, pilih "Kirim pesan" — otomatis membuka chat dan pindah ke percakapan 1-on-1 dengan orang itu.',
  },
  {
    keywords: ['mention', 'tag orang', 'tandai orang'],
    question: 'Bisa mention orang di chat?',
    answer: 'Bisa, di channel dan DM (tidak di chat zone-privat atau mode "Say nearby"). Ketik "@" lalu beberapa huruf nama — muncul daftar pilihan orang yang cocok untuk diklik/dipilih.',
  },
  {
    keywords: ['kirim file', 'kirim gambar', 'kirim video', 'upload file', 'attach', 'klip kertas', 'kirim dokumen'],
    question: 'Bisa kirim file/gambar di chat?',
    answer: 'Bisa, di channel/DM dan chat zone-privat (tidak di mode "Say nearby"). Klik ikon klip kertas, pilih Gambar/Video/Dokumen (Dokumen tidak dibatasi tipe file). Batas ukuran 50MB per file.',
  },
  {
    keywords: ['pin pesan', 'sematkan', 'pengumuman', 'banner pengumuman'],
    question: 'Bisa pin pesan jadi pengumuman?',
    answer: 'Bisa, tapi hanya admin. Klik-kanan sebuah pesan untuk buka menunya: "Sematkan pesan" (pin di channel/DM itu saja) atau "Jadikan pengumuman" (jadi banner pengumuman ungu di atas layar semua orang, sampai admin lepas).',
  },
  {
    keywords: ['edit pesan', 'hapus pesan', 'delete pesan', 'ubah pesan'],
    question: 'Bisa edit/hapus pesan sendiri?',
    answer: 'Bisa, untuk pesan channel/DM milik sendiri saja — muncul link Edit/Delete di bawah pesan. Pesan yang diedit dapat label "(diedit)".',
  },
  {
    keywords: ['belum dibaca', 'dibaca oleh', 'sedang mengetik', 'typing', 'read receipt'],
    question: 'Ada tanda pesan belum dibaca atau lagi ada yang ngetik?',
    answer: 'Ada badge angka pesan-belum-dibaca di tombol Chat dan tiap tab channel/DM. Klik-kanan pesan juga bisa lihat "Dibaca oleh" siapa saja.\nAda juga indikator "sedang mengetik..." di atas kolom chat kalau ada orang yang lagi ngetik (khusus channel/DM).',
  },

  // Meeting View
  {
    keywords: ['meeting view', 'video call layar penuh', 'tampilan video call', 'grid video'],
    question: 'Gimana cara buka Meeting View (tampilan video call layar penuh)?',
    answer: 'Manual, bukan otomatis. Begitu ada tile kamera muncul di strip video dekat pojok kanan-atas (karena sudah dekat orang lain), klik tombol "Meeting View" (ikon grid) di sebelah tombol sembunyikan-tile untuk masuk tampilan layar penuh.',
  },
  {
    keywords: ['spotlight', 'sorot', 'tampilan utama', 'fokus ke satu orang'],
    question: 'Gimana cara nyorot (spotlight) satu orang jadi tampilan utama?',
    answer: 'Kalau belum ada yang disorot dan tidak ada yang share layar, semua orang tampil rata di grid — klik tile siapa pun untuk jadikan dia tampilan utama besar (yang lain masuk strip thumbnail di bawah).\nKlik thumbnail lain untuk ganti siapa yang disorot. Klik tombol "Lepas" di pojok tile utama untuk kembali ke mode otomatis.',
  },
  {
    keywords: ['share otomatis utama', 'share screen meeting view', 'share jadi utama'],
    question: 'Kalau ada yang share layar di Meeting View, otomatis jadi tampilan utama?',
    answer: 'Ya, otomatis — begitu seseorang mulai share layar, langsung jadi tampilan utama untuk semua orang, bahkan menggantikan orang yang sedang disorot manual.',
  },
  {
    keywords: ['keluar meeting view', 'tutup meeting view', 'leave call', 'tombol x meeting'],
    question: 'Gimana cara keluar dari Meeting View?',
    answer: 'Klik tombol bulat "X" di pojok kanan-atas layar Meeting View — kembali ke tampilan peta biasa. Tidak ada "leave call" terpisah; menutup Meeting View itulah cara keluarnya.',
  },
  {
    keywords: ['reaksi meeting view', 'emoji meeting view', 'strip reaksi'],
    question: 'Ada reaksi emoji cepat khusus di Meeting View?',
    answer: 'Ada. Tombol emoji di toolbar yang biasanya buka roda-emote, di dalam Meeting View malah membuka strip reaksi cepat horizontal di bagian bawah layar.',
  },

  // Ruang & Akses
  {
    keywords: ['bikin space', 'buat space', 'create space', 'bikin room baru', 'buat room baru'],
    question: 'Siapa yang bisa bikin Space baru?',
    answer: 'Hanya akun dengan role admin — tombol "+ Create Space" di Lobby cuma muncul untuk admin.\nSaat membuat, admin memilih Nama Room, Layout (Main Office / Small Team / Open Lounge / Kaitech Office), dan Tema (Modern Interiors / Sci-Fi Office).',
  },
  {
    keywords: ['masuk room', 'join room', 'klik kartu room', 'lobby masuk'],
    question: 'Gimana cara masuk ke room dari Lobby?',
    answer: 'Klik saja di mana pun pada kartu room — seluruh kartu bisa diklik, tidak ada tombol "Join" terpisah.',
  },
  {
    keywords: ['join with code', 'kode room', 'room privat kode', 'masuk pakai kode'],
    question: 'Apa itu tombol "Join with Code"?',
    answer: 'Daftar room di Lobby cuma menampilkan room yang PUBLIK. "Join with Code" dipakai untuk masuk ke room privat/tidak-terdaftar — seseorang membagikan kode room (slug URL)-nya, tinggal ditempel di sana untuk langsung masuk.',
  },
  {
    keywords: ['kunci zone', 'kunci area', 'kunci ruangan', 'lock zone', 'room features kunci'],
    question: 'Bisa mengunci satu area/zone biar orang lain tidak bisa masuk seenaknya?',
    answer: 'Bisa, untuk member (bukan tamu). Kontrolnya ada di menu "Room Features" di sidebar, baris "Kunci <Nama Zone>" — cuma muncul saat sedang berdiri di dalam zone itu.\nSiapa pun yang berdiri di zone saat menguncinya jadi pemegang kunci; cuma dia yang bisa membuka lagi.',
  },
  {
    keywords: ['zone dikunci', 'ketuk pintu', 'minta masuk zone', 'zone terkunci'],
    question: 'Kalau zone dikunci, orang lain gimana caranya minta masuk?',
    answer: 'Mereka lihat kartu "<Zone> sedang dikunci" dengan tombol "Ketuk pintu". Setelah mengetuk, mereka menunggu; pemegang kunci dapat popup "<Nama> mau masuk <Zone>" dengan pilihan Izinkan/Tolak.',
  },
  {
    keywords: ['zone khusus anggota', 'member only', 'minta izin masuk', 'guest diblokir'],
    question: 'Apa bedanya zone "khusus anggota" dengan zone yang dikunci manual?',
    answer: 'Zone "khusus anggota" itu setelan permanen dari desainer room (bukan dikunci dadakan oleh satu orang) — guest yang coba masuk selalu butuh persetujuan admin, member biasa bebas masuk.\nGuest yang diblokir lihat tombol "Minta izin masuk"; SEMUA admin yang sedang online (bukan cuma satu keyholder) melihat permintaannya dan siapa yang merespons duluan yang memutuskan.',
  },
  {
    keywords: ['summon', 'panggil orang', 'undang ke lokasi', 'panggil ke sini'],
    question: 'Bisa manggil/undang orang lain ke lokasiku?',
    answer: 'Bisa (fitur "Summon"), untuk member (bukan tamu, dan tidak bisa dipakai oleh tamu). Buka panel Peserta, menu titik-tiga di nama orang, pilih "Panggil ke sini".\nOrang yang dipanggil dapat popup Terima/Tolak — cuma pindah kalau dia Terima.',
  },
  {
    keywords: ['pintu password', 'password pintu', 'buka semua pintu', 'pintu terkunci'],
    question: 'Ada pintu yang butuh password?',
    answer: 'Ada. Saat avatar mendekati pintu berpassword, muncul form password otomatis (atau tekan F kalau pintu itu setelannya "tekan F"). Password salah akan ditolak dengan pesan error.\nAdmin punya tombol darurat "Buka Semua Pintu (Darurat)" di menu Room Features untuk membuka semua pintu berpassword sekaligus.',
  },
  {
    keywords: ['kursi tetap', 'assign seat', 'my seat', 'kursi favorit', 'klaim kursi'],
    question: 'Bisa punya kursi/meja tetap yang gampang dibalikin?',
    answer: 'Bisa. Saat duduk di kursi mana pun, ada tombol "Assign as My Seat" untuk menjadikannya kursi tetap milikmu (tersimpan di akun). Ada juga penanda kursi khusus di beberapa room yang bisa diklaim langsung.\nSetelah punya kursi, ikon "Go to My Seat" muncul di sidebar — sekali klik langsung teleport ke sana.',
  },
  {
    keywords: ['room perlu izin', 'perlu persetujuan', 'room dibatasi', 'akses khusus', 'minta izin bergabung'],
    question: 'Ada room yang perlu izin admin dulu sebelum bisa masuk?',
    answer: 'Ada, kalau room itu di-setting admin untuk "perlu persetujuan". Member yang coba masuk akan lihat layar "Room ini perlu persetujuan" dengan tombol "Minta izin bergabung", lalu menunggu sampai admin menyetujui/menolak (halaman otomatis update, tidak perlu refresh).\nAda juga tingkat "Room dibatasi (akses khusus)" yang lebih ketat — tidak ada opsi minta izin sendiri sama sekali, hanya orang yang sudah diberi akses langsung oleh admin yang bisa masuk.',
  },

  // Booking "Ngobrol dengan CEO"
  {
    keywords: ['booking ceo', 'ngobrol dengan ceo', 'jadwal ceo', 'tombol g'],
    question: 'Gimana cara booking jadwal ngobrol dengan CEO?',
    answer: 'Tekan tombol G di mana pun saat berada di dalam room (tidak perlu berdiri dekat ruangan CEO) — fitur ini khusus akun member, tidak untuk tamu.\nMuncul form: pilih jam Mulai & Selesai (bawaan 14:00–15:00), isi "Keperluan" (opsional), lalu klik "Ajukan booking".',
  },
  {
    keywords: ['status booking', 'menunggu persetujuan ceo', 'booking disetujui', 'auto summon ceo'],
    question: 'Setelah ajukan booking, terus gimana?',
    answer: 'Statusnya "Menunggu persetujuan CEO..." sampai orang yang punya akses CEO menyetujui atau menolak permintaanmu lewat popup di layar mereka.\nSetelah disetujui, kartu berubah jadi "Booking disetujui — menunggu jadwal", lengkap dengan jam booking-nya. Kamu TIDAK perlu melakukan apa-apa lagi — begitu jamnya tiba, kamu otomatis dipindahkan (auto-summon) ke ruangan CEO.',
  },
  {
    keywords: ['batalin booking', 'batalkan booking', 'cancel booking'],
    question: 'Bisa batalin booking yang sudah diajukan?',
    answer: 'Bisa, klik "Batalkan booking" di kartu notifikasinya kapan saja sebelum atau sesudah disetujui.',
  },
  {
    keywords: ['tutup notifikasi booking', 'notif booking hilang', 'jam pasir', 'notifikasi booking'],
    question: 'Kalau aku tutup (X) notifikasi booking-nya, bookingnya ikut batal?',
    answer: 'Tidak. Tombol X di pojok kartu cuma menyembunyikan tampilannya — booking-nya TETAP aktif dan tetap akan auto-masuk sesuai jadwal. Untuk benar-benar membatalkan, harus pakai tombol "Batalkan booking", bukan X.\nNotifikasinya bisa dibuka lagi kapan saja lewat ikon jam-pasir di sidebar (muncul selama booking-mu masih aktif). Notifikasi juga otomatis muncul lagi sendiri kalau ada booking baru atau booking-mu baru saja disetujui.',
  },
  {
    keywords: ['selesai meeting', 'akhiri sesi ceo', 'ceo akhiri', 'ceo selesai'],
    question: 'Sebagai CEO, gimana cara mengakhiri sesi meeting lebih awal?',
    answer: 'Selama sesi booking sedang aktif (orangnya sudah masuk ruangan), muncul tombol "Selesai meeting" — klik untuk langsung mengakhiri sesi itu tanpa menunggu waktu habis sendiri.',
  },

  // Guest Link (Tamu)
  {
    keywords: ['guest link', 'buat guest link', 'link undangan', 'link tamu'],
    question: 'Gimana cara admin membuat link undangan untuk tamu (tanpa akun)?',
    answer: 'Di menu Room Features (sidebar), admin klik "Buat Guest Link". Akan ditanya: berapa jam link berlaku (kosongkan = tanpa batas waktu), apakah link sekali-pakai saja, dan password link (kosongkan = dibuatkan otomatis).\nLink dan password-nya langsung tampil sekali (link juga otomatis tersalin ke clipboard) — admin harus membagikan KEDUA-nya ke tamu, karena password tidak bisa dilihat lagi setelah itu.',
  },
  {
    keywords: ['masuk sebagai tamu', 'masuk tamu', 'join sebagai guest', 'tanpa akun'],
    question: 'Gimana cara masuk sebagai tamu?',
    answer: 'Buka link undangan yang diberikan — muncul halaman "Masuk sebagai Tamu". Isi nama dan password link-nya, lalu klik "Gabung". Tidak perlu bikin akun/email sama sekali.',
  },
  {
    keywords: ['ruang tunggu', 'tamu menunggu', 'tamu disetujui', 'tamu approve'],
    question: 'Setelah isi nama & password, langsung masuk room?',
    answer: 'Belum langsung — tamu masuk "ruang tunggu" dulu. Admin yang online akan melihat notifikasi permintaan masuk dari tamu tersebut dan harus menyetujuinya (Izinkan/Tolak) sebelum tamu benar-benar masuk ke room.',
  },
  {
    keywords: ['cabut guest link', 'revoke guest link', 'hapus guest link', 'batalkan guest link'],
    question: 'Gimana cara mencabut (revoke) guest link?',
    answer: 'Admin klik "Cabut Guest Link Terakhir" di menu Room Features (hanya bisa mencabut link yang PALING TERAKHIR dibuat — belum ada daftar/riwayat semua link).\nSetelah dicabut: link langsung tidak bisa dipakai untuk masuk baru, DAN tamu yang saat itu sedang di dalam room lewat link tersebut langsung dikeluarkan otomatis (bukan cuma link-nya mati).',
  },

  // Lain-lain
  {
    keywords: ['reaksi emoji', 'emote', 'tombol b', 'roda emote'],
    question: 'Gimana cara kasih reaksi emoji?',
    answer: 'Tekan tombol B, atau klik tombol emoji di toolbar bawah — muncul roda pilihan emote yang tampil di atas avatarmu, kelihatan oleh orang-orang di sekitar.',
  },
  {
    keywords: ['angkat tangan', 'raise hand', 'tombol h', 'tangan kuning'],
    question: 'Gimana cara angkat tangan (raise hand)?',
    answer: 'Tekan tombol H, atau klik tombol tangan di toolbar bawah. Muncul ikon tangan berwarna kuning di atas avatarmu dan di tile videomu, kelihatan oleh semua orang — tekan lagi untuk menurunkan.',
  },
  {
    keywords: ['matiin tooltip', 'petunjuk tombol', 'hint tombol', 'tooltip'],
    question: 'Ada pengaturan buat matiin tooltip/petunjuk di tombol-tombol toolbar?',
    answer: 'Ada, di menu Settings (ikon gear di sidebar, atau dari menu akun di Lobby) → bagian "Tampilan" → toggle "Tampilkan tooltip". Kalau dimatikan, penjelasan detail saat hover ke tombol-tombol meeting tidak akan muncul lagi.',
  },
  {
    keywords: ['pengaturan notifikasi', 'setting notifikasi', 'matiin notifikasi', 'suara notifikasi'],
    question: 'Ada pengaturan notifikasi?',
    answer: 'Ada, di Settings → bagian "Notifikasi". Ada toggle master untuk notifikasi browser & suara, plus toggle terpisah per jenis kejadian: pesan chat, disebut (@mention), disenggol, dicolek, dan ada yang angkat tangan — masing-masing bisa dimatikan sendiri-sendiri, dan tersimpan ke akun (ikut kalau login di perangkat lain).',
  },
  {
    keywords: ['logout', 'keluar akun', 'sign out'],
    question: 'Gimana cara logout?',
    answer: 'Buka Settings → bagian "Akun" → tombol Logout — akan ada konfirmasi dulu sebelum benar-benar keluar dari akun.',
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
