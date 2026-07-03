# PROMPT — Lanjutkan Project "VirtualMeet" (Gather.town Clone)

> Tempel prompt di bawah ini ke Claude Code (atau AI coding agent lain) di root folder project `meetkai-main`. Sebelum itu, extract & taruh file aset sesuai struktur folder di bagian "Persiapan" biar agent bisa langsung baca filenya.

---

## 0. Konteks (untuk kamu, bukan bagian yang dipaste)

Project `meetkai-main` **sudah jadi ~70%**. Ini bukan project kosong. Yang sudah ada:
- Movement WASD + sync posisi realtime (Socket.IO)
- Proximity-based audio/video call (WebRTC)
- Chat + chat bubble di atas avatar
- Emote wheel, minimap, room editor, admin panel
- Auth (login/register), Postgres (Prisma) + Redis
- Avatar customization (bentuk, warna, aksesori) — tapi **masih digambar manual pakai shape Canvas**, belum pakai sprite pixel-art

Yang kosong / lemah:
- Avatar & tile map masih placeholder (lingkaran warna, kotak warna), belum sprite asli
- Belum ada sistem sprite sheet loader + animasi walk-cycle per arah
- Belum ada tilemap editor visual berbasis tileset asli (drag & drop objek dari aset)
- Belum ada beberapa fitur Gather.town: zone privat/meeting room bersekat, screen share, spawn point per map, multiple maps/rooms

Aset yang kamu punya (LimeZu "Modern Interiors" + "Modern Office" + karakter) itu pas banget karena secara desain memang dibuat untuk gaya "Gather.town-like", termasuk `Character_Generator` yang komponennya sudah terpisah per body/hair/outfit/eyes/accessory — cocok untuk sistem avatar layered.

---

## 1. Persiapan sebelum jalankan prompt

✅ **Sudah beres** — aset sudah diextract, dikurasi ke resolusi 32x32, dan ditaruh langsung
di `client/public/assets/` di dalam project ini. Tinggal extract zip project ini apa adanya,
tidak perlu extract ulang zip aset asli. Detail lengkap tiap folder ada di
`client/public/assets/ASSETS_README.md` — **suruh agent baca file itu duluan** sebelum mulai
Tahap 1, supaya tahu persis nama file, layout spritesheet, dan urutan layer avatar.

Struktur yang sudah tersedia:

```
client/public/assets/
├── ASSETS_README.md                <- baca ini duluan
├── tilesets/
│   ├── modern-interiors/           <- tileset gabungan + room builder + singles per tema
│   └── modern-office/              <- tileset kantor modern + singles
└── characters/
    ├── generator/                  <- komponen layered: Bodies, Hairstyles, Outfits, Eyes,
    │                                   Accessories, Books, Smartphones (32x32)
    └── premade/
        ├── generator-premade/      <- karakter jadi hasil Character Generator (32x32)
        └── free-pack-16x16/        <- Adam, Alex, Amelia, Bob dst (16x16, idle/run/sit/phone)
```

---

## 2. PROMPT UNTUK DI-PASTE KE AGENT

```
Kamu bekerja di dalam project "VirtualMeet" (clone Gather.town) yang sudah berjalan dengan stack:
React + TypeScript + Vite (client), Node.js + Express + Socket.IO + Prisma + Redis (server),
state management Zustand, canvas rendering manual di client/src/components/canvas/GameCanvas.tsx
dan AvatarSprite.ts. Tipe & konstanta bersama ada di shared/types/index.ts.

Baca dulu file-file berikut sebelum ubah apapun, supaya paham arsitektur yang sudah ada:
- client/src/App.tsx
- client/src/components/canvas/GameCanvas.tsx
- client/src/components/canvas/AvatarSprite.ts
- client/src/hooks/useAvatarConfig.ts
- client/src/components/avatar/AvatarSetup.tsx
- client/src/stores/gameStore.ts
- shared/types/index.ts
- server/src/socket/roomHandler.ts
- server/prisma/schema.prisma

JANGAN membangun ulang dari nol. Perbaiki dan perluas kode yang sudah ada, jangan ganti
arsitektur Socket.IO / Zustand / Prisma yang sudah berjalan.

Aset pixel-art sudah tersedia di client/public/assets/ dengan struktur:
- assets/tilesets/modern-interiors/  (tileset interior 32x32, banyak tema: office, kitchen,
  living room, conference hall, dst — nama folder berformat "N_NamaTema_Singles_32x32")
- assets/tilesets/modern-office/     (tileset khusus kantor modern)
- assets/characters/generator/       (komponen avatar terpisah: Bodies, Hairstyles, Outfits,
  Eyes, Accessories, Books, Smartphones — masing-masing folder berisi banyak varian PNG
  32x32 dengan frame walk-cycle 4 arah standar RPG Maker: down/left/right/up, biasanya
  3 frame per arah dalam satu spritesheet)
- assets/characters/premade/         (karakter siap pakai: Adam, Alex, Amelia, Bob, dll,
  masing-masing punya file _16x16.png utama plus animasi terpisah _idle, _run, _sit, _phone)

TUGAS — kerjakan berurutan, commit per tahap:   

### Tahap 1 — Sprite loader & rendering engine
1. Buat util pemuat spritesheet (client/src/utils/spriteLoader.ts) yang bisa memotong
   spritesheet grid (frame width/height configurable) jadi array frame, dengan caching
   supaya gambar tidak di-load ulang tiap render.
2. Refactor AvatarSprite.ts: ganti fungsi drawAvatar yang saat ini menggambar shape manual
   (circle/rounded-square/hexagon) menjadi fungsi yang menggambar sprite PNG sesuai
   direction (up/down/left/right) dan animation state (idle/walking), dengan frame
   cycling berbasis delta time.
3. Sistem avatar harus LAYERED: body -> outfit -> hairstyle -> accessory -> item (phone/book),
   digambar bertumpuk di posisi yang sama per frame, supaya AvatarConfig yang sudah ada
   (bodyShape, color, accessory, expression) bisa dipetakan ke kombinasi layer sprite ini.
   Perbarui tipe AvatarConfig di shared/types/index.ts jika perlu menambah field baru
   (mis. bodyId, hairId, outfitId, eyesId) — tapi pertahankan backward compatibility
   sebisa mungkin (field lama tetap ada atau ada migrasi default value).
4. Update GameCanvas.tsx: ganti TILE_COLORS (warna solid per TileType) menjadi rendering
   tile dari tileset PNG asli, gunakan tileset "Room_Builder" atau tema office sebagai
   default map, dengan tetap mempertahankan logic BLOCKED_TILES untuk collision.

### Tahap 2 — Avatar customization UI
5. Update AvatarSetup.tsx dan AvatarEditorButton.tsx: ganti color picker & shape picker
   yang sekarang jadi UI pemilih sprite bergaya "character creator" — preview avatar
   real-time, tombol next/prev per kategori (body/hair/outfit/eyes/accessory), searah
   dengan folder assets/characters/generator/. Simpan pilihan combo ini di
   useAvatarConfig.ts (localStorage) sama seperti sekarang.
6. Tambahkan opsi "pakai karakter premade" (Adam/Alex/Amelia/dst dari
   assets/characters/premade/) sebagai alternatif cepat selain avatar builder layered.

### Tahap 3 — Room / Map system pakai tileset asli
7. Perluas RoomEditor.tsx: saat ini room editor hanya mengubah TileType generik
   (floor/wall/door/desk/chair). Tambahkan konsep "tile palette" yang mengambil ubin dari
   tileset PNG (misal tema Conference_Hall atau Modern_Office) sehingga admin bisa
   klik-pilih ubin dari palet visual, bukan cuma pilih tipe generik.
8. Tambahkan dukungan multi-layer tilemap (lantai, objek/furniture, atas-avatar/atap)
   supaya furniture besar dari tileset (meja, sofa, rak) bisa digambar menutupi beberapa
   petak dan avatar bisa berjalan "di belakang" objek yang lebih tinggi dari 1 tile.
9. Update server/prisma/schema.prisma & roomStore.ts bila struktur data tilemap perlu
   field tambahan (mis. layer index, tileset id per tile) — buat migration Prisma-nya.

### Tahap 4 — Fitur yang belum ada dibanding Gather.town
10. Private/meeting zone: room bisa punya area "zona privat" (mis. meeting room bersekat)
    di mana audio/video HANYA nyambung ke sesama avatar yang berada di zona yang sama,
    terlepas dari jarak proximity radius global. Server sudah punya
    server/src/socket/zoneHandler.ts — cek dan lengkapi implementasinya, integrasikan ke
    useProximity.ts dan useWebRTC.ts di client.
11. Multiple rooms/maps: tambahkan kemampuan membuat beberapa room map berbeda dalam satu
    workspace (mis. "Lobby", "Kantor Lantai 2", "Ruang Santai"), dengan pintu/portal tile
    yang saat diinjak avatar akan memindahkan user ke map lain (emit event pindah room via
    Socket.IO, load tilemap baru di client).
12. Screen sharing: tambahkan tombol share-screen di HUD (di samping MicButton dan
    CameraButton yang sudah ada), gunakan getDisplayMedia() dan alirkan lewat
    webrtcService.ts yang sudah ada sebagai track tambahan.
13. Spawn point: saat join room, avatar harus muncul di tile bertipe "spawn" (bukan selalu
    di 0,0), ambil dari data tilemap.

### Tahap 5 — Polish
14. Pastikan npm run typecheck dan npm run lint (workspace root) tetap lolos setelah semua
    perubahan.
15. Update project.md: centang item roadmap yang sudah selesai, update bagian "Tech Stack"
    dan "Project Structure" kalau ada file/folder baru yang ditambahkan.
16. Uji manual: 2 browser tab join room yang sama, pastikan sprite avatar tampil benar
    per arah gerak, tile map tampil dari asset asli, dan audio/video proximity tetap jalan
    seperti sebelumnya (jangan sampai regresi fitur yang sudah ada).

Kerjakan satu tahap penuh dulu sampai bisa dijalankan tanpa error sebelum lanjut ke tahap
berikutnya. Di akhir tiap tahap, laporkan ringkas file apa saja yang diubah/ditambah.
```

---

## 3. Catatan tambahan (opsional, kalau mau kamu sisipkan sendiri ke prompt)

- Kalau server belum ada Postgres/Redis jalan lokal, minta agent tambahkan fallback in-memory dulu (kelihatannya `roomStore.ts` sudah punya mode in-memory kalau Redis tidak connect — biarkan agent pakai itu untuk development cepat).
- `Character_Generator_2_0_*.zip` dan `.exe` itu **aplikasi Unity desktop** buat generate karakter secara offline — tidak perlu ikut dimasukkan ke project web, cukup dipakai manual kalau kamu mau bikin varian karakter custom baru lalu export PNG-nya ke `assets/characters/`.
- Kalau nanti butuh lisensi commercial untuk aset LimeZu (Modern Interiors/Office), cek dulu tier lisensi yang kamu beli sebelum publish produk final — itu di luar scope kode.
