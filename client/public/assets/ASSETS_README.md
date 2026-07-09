# Asset Map — client/public/assets/

Semua aset di sini sudah dikurasi ke resolusi **32x32** (satu ukuran konsisten) dari paket
LimeZu "Modern Interiors" & "Modern Office". Struktur:

```
assets/
├── tilesets/
│   ├── modern-interiors/
│   │   ├── Interiors_32x32.png              <- tileset gabungan, semua tema jadi satu sheet
│   │   ├── Room_Builder_32x32.png           <- base building blocks (lantai/dinding/pintu)
│   │   ├── Room_Builder_subfiles_32x32/     <- potongan per elemen room builder
│   │   └── Theme_Sorter_Singles_32x32/      <- objek per-tema, per-file (mudah dipakai
│   │                                            sebagai palet di room editor: kantor,
│   │                                            dapur, gym, conference hall, dll)
│   └── modern-office/
│       ├── Modern_Office_32x32.png          <- tileset kantor modern (versi dengan bayangan)
│       ├── Room_Builder_Office_32x32.png    <- base building blocks tema kantor
│       ├── Modern_Office_Shadowless_32x32.png
│       └── Modern_Office_Singles_32x32/     <- objek kantor per-file (meja, kursi, dsb)
│
└── characters/
    ├── generator/                  <- KOMPONEN AVATAR TERPISAH (layered), semua 32x32
    │   ├── Bodies/                 <- base body per warna kulit
    │   ├── Hairstyles/             <- banyak model rambut x warna
    │   ├── Outfits/                <- banyak baju/kostum
    │   ├── Eyes/                   <- variasi mata
    │   ├── Accessories/            <- topi, kacamata, dll
    │   ├── Books/                  <- prop buku (opsional, utk animasi "membaca")
    │   ├── Smartphones/            <- prop HP (opsional, utk animasi "telepon")
    │   ├── CHARACTER_GENERATOR.txt         <- dokumentasi asli dari pembuat aset
    │   ├── Spritesheet_animations_GUIDE.png <- panduan layout frame animasi (arah & jumlah frame)
    │   └── HOW_TO_CHARACTER_GENERATOR.png
    │
    └── premade/                    <- karakter siap pakai (tidak perlu di-layer manual)
        └── generator-premade/      <- hasil kombinasi jadi dari Character Generator, 32x32

```

## Catatan penting untuk implementasi sprite loader

- **Layout frame**: cek `characters/generator/Spritesheet_animations_GUIDE.png` untuk tahu
  urutan baris/kolom (arah down/left/right/up) dan jumlah frame per state (idle/walk) di
  setiap file PNG Character Generator. Semua file dalam satu kategori (mis. semua file di
  `Bodies/`) memakai layout grid yang sama, jadi util pemotong spritesheet cukup dibuat
  sekali lalu dipakai untuk semua kategori.
- **Layer order saat digambar** (dari belakang ke depan): Body → Outfit → Hairstyle →
  Eyes → Accessory → (Books/Smartphones sebagai prop tangan, opsional).
- **Tileset "Singles" vs sheet gabungan**: pakai folder `*_Singles_32x32/` untuk UI palet
  room editor (tiap file = satu objek, gampang di-list & di-preview). Pakai
  `Interiors_32x32.png` / `Modern_Office_32x32.png` (sheet gabungan) kalau butuh render
  tilemap dari data grid x/y source-rect, bukan drag-drop objek satuan.

## Aset yang SENGAJA tidak disertakan di sini

- `Character_Generator_2_0_*.zip/.exe` — aplikasi Unity desktop untuk generate karakter
  offline, bukan file gambar. Dipakai manual di luar project kalau perlu bikin varian
  baru, lalu hasil PNG-nya taruh di folder `characters/` ini.
- `Modern_Interiors_RPG_Maker_Version.zip` — format khusus engine RPG Maker, redundant
  dengan tileset 32x32 yang sudah ada di sini untuk kebutuhan web canvas.
- Resolusi 16x16 dan 48x48 dari Character Generator & tileset lain — disederhanakan ke
  32x32 saja supaya konsisten satu ukuran di seluruh game.
