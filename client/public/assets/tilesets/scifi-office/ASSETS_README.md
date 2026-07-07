# Asset Map — tilesets/scifi-office/ (dari Space Station 14, CC-BY-SA 3.0)

Tileset ini beda dari `modern-interiors`/`modern-office` (LimeZu) yang sudah ada — ini
bergaya **sci-fi/space station** (dinding metal, komputer, meja modern), mendekati gaya
visual referensi ZEP kamu. Semua 32x32, format PNG per-state (mirip spritesheet tapi
satu file per pose/varian, bukan satu sheet besar).

```
scifi-office/
├── ATTRIBUTION.md        <- WAJIB baca & sertakan kredit ini di halaman "About" MeetKai
├── Furniture/
│   ├── chairs.rsi/        <- kursi kantor (office-white, office-dark, bar, stool, dst)
│   ├── folding_chair.rsi/
│   ├── potted_plants.rsi/ <- tanaman hias
│   ├── bookshelf.rsi/
│   ├── furniture.rsi/     <- bed/rack/dresser (kurang relevan buat office, opsional dipakai)
│   └── Tables/            <- BANYAK varian meja: generic, glass, wood, stone, brass, dst
│       ├── generic.rsi/   <- meja standar abu-abu, paling netral buat office
│       ├── glass.rsi/
│       ├── wood.rsi/
│       └── ...
├── Machines/
│   ├── computers.rsi/     <- komputer meja kerja (banyak varian state, cek meta.json)
│   ├── server.rsi/        <- rak server, cocok buat "DEV TEAM"/server room
│   ├── fax_machine.rsi/
│   ├── arcade.rsi/        <- cocok buat area lounge/santai
│   ├── jukebox.rsi/       <- cocok buat lounge
│   ├── station_map.rsi/   <- peta dinding, bisa jadi dekorasi info board
│   ├── holopad.rsi/       <- panel hologram, cocok jadi dekorasi sci-fi
│   └── smartfridge.rsi/   <- cocok buat pantry
├── Walls/
│   ├── solid.rsi/          <- dinding metal polos, PALING RECOMMENDED buat dinding utama
│   ├── solid_diagonal.rsi/ <- versi diagonal/pojok dari solid
│   ├── shuttle.rsi/        <- varian dinding shuttle (agak beda tone)
│   └── (banyak varian lain: brick, ice, gold, dst — kebanyakan TIDAK cocok tema office,
│         pilih solid.rsi sebagai default)
├── Doors/                  <- pintu sci-fi otomatis (banyak varian per departemen warna)
├── Tiles/                  <- lantai (banyak varian: steel, plastic, dsb)
└── Decals/                 <- garis/marka lantai (arrow, hazard stripe, dll — dekorasi)
```

## Cara pakai tiap file .rsi

Setiap folder `xxx.rsi/` punya:
- `meta.json` — daftar "states" (nama varian/pose) dan info animasi (`delays` kalau ada
  animasi). Field `size` di meta.json = ukuran 1 frame (biasanya 32x32).
- File PNG per state (misal `office-white.png`) — ini KADANG berisi 1 gambar statis,
  KADANG berisi spritesheet 4-arah (4 kolom untuk down/right/up/left, sesuai urutan
  standar RSI/Robust Toolbox) kalau field `directions: 4` ada di meta.json untuk state itu.
  Cek `directions` di meta.json per-state untuk tahu apakah file itu perlu dipotong 4 arah
  atau dipakai langsung sebagai 1 gambar utuh.
- File `full.png` (kalau ada, biasanya di folder Tables) — preview gabungan/bentuk utuh
  meja dari 4 sisi, guna referensi visual cepat, BUKAN untuk dipotong sebagai sprite game
  (pakai state_0.png dst untuk itu, itu potongan per-arah/per-bagian meja).

## Rekomendasi kombinasi cepat buat tema "office" (biar nggak overwhelmed 208 item)

- Dinding: `Walls/solid.rsi`
- Lantai: pilih 1-2 varian dari `Tiles/` yang warnanya netral (cek preview manual)
- Meja: `Furniture/Tables/generic.rsi`
- Kursi: `Furniture/chairs.rsi` (state `office-white` atau `office-dark`)
- Komputer di atas meja: `Machines/computers.rsi` (state `computer`)
- Server room / DEV TEAM: `Machines/server.rsi`
- Lounge: `Machines/arcade.rsi` + `Machines/jukebox.rsi` + `Furniture/potted_plants.rsi`
- Pantry: `Machines/smartfridge.rsi`
- Pintu: pilih 1 varian netral di `Doors/` (banyak yang warna departemen, cek preview)

## WAJIB — Lisensi

Baca `ATTRIBUTION.md` di folder ini. Aset ini **CC-BY-SA 3.0**, gratis & boleh komersial,
TAPI wajib kredit ke kontributor aslinya (daftar lengkap ada di ATTRIBUTION.md) di
halaman "About"/"Credits" MeetKai. Ini beda dari tileset LimeZu yang sebelumnya (itu
lisensi beli-putus tanpa wajib kredit) — jangan disamakan aturannya.
