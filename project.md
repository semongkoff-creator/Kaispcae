# 🗺️ VirtualMeet — Interactive Meeting System
> *Inspired by Gather.town & Zep.us — A 2D avatar-based virtual meeting space*

---

## 📌 Project Overview

**VirtualMeet** adalah sistem meeting interaktif berbasis browser di mana setiap peserta memiliki avatar 2D yang dapat bergerak bebas di dalam ruangan virtual yang bisa di-kustomisasi. Pengguna bisa berjalan mendekati satu sama lain untuk memicu interaksi audio/video secara otomatis (proximity-based interaction), mirip seperti percakapan nyata.

---

## 🎯 Core Features

| Feature | Deskripsi |
|---|---|
| 🧍 Avatar System | Avatar pixel-art layered (body/eyes/outfit/hair/accessory) dari Character Generator pack, atau pilih dari 20 karakter premade, dengan fallback shape-drawn untuk avatar lama |
| 🗺️ Room Builder | Tile-based map dari tileset asli (LimeZu Modern Interiors/Office), multi-layer (floor/object/overhead), furniture multi-cell, zona privat |
| 🚶 Movement | Avatar bergerak dengan WASD / Arrow keys, animasi walk-cycle 4 arah, collision terhadap wall/desk/chair/furniture |
| 🎙️ Proximity Audio | Mic/speaker aktif otomatis berdasar jarak antar avatar, atau otomatis penuh kalau sama-sama di dalam zona privat |
| 🎥 Video Call | WebRTC peer-to-peer, video muncul saat avatar berdekatan (atau di zona yang sama) |
| 🖥️ Screen Sharing | Share layar ke peer yang terhubung lewat tombol HUD, otomatis kembali ke webcam saat berhenti |
| 💬 Chat & Emote | Chat panel + speech bubble di atas avatar, emote wheel radial |
| 🏠 Room Editor | Admin bisa cat tile (tipe generik & tekstur visual dari tileset asli), taruh furniture, gambar zona privat (drag), taruh portal & spawn point |
| 🌀 Portal & Multi-Room | Tile portal memindahkan avatar ke room lain (slug) secara real-time |
| 👑 Admin System | Master admin (pemilik room) & admin biasa, grant/revoke lewat panel admin |
| 👤 User Auth | Register/login (JWT + bcrypt), profil, avatar config tersimpan per user |
| 🏷️ Zona Berlabel | Zona bisa punya label/warna/tipe (meeting/desk/focus/general) — banner besar untuk meeting, pill kecil untuk desk/focus, dirender sebagai DOM overlay di atas canvas |
| 💬 Status Custom | Peserta bisa set status bebas (mis. "WFH", "In a meeting") lewat tombol cepat, tampil sebagai badge kecil di atas nametag |
| 🔒 Chat Per-Zona | Tab "Private" otomatis muncul di Chat panel saat berada di dalam zona — pesan hanya terkirim ke peserta lain yang ada di zona yang sama |
| 👥 Panel Peserta | Panel kolaps berisi semua peserta online (status masing-masing) + thumbnail video untuk 2-3 peserta yang sedang video call, dengan indikator "+N" untuk sisanya |

---

## 🏗️ Tech Stack

```
Frontend       : React + TypeScript + Vite
State          : Zustand (gameStore)
Rendering      : HTML5 Canvas — sprite/tileset rendering ditulis manual (bukan game engine)
Real-time      : Socket.IO (WebSocket)
Audio/Video    : WebRTC peer-to-peer murni (RTCPeerConnection langsung, tanpa SFU/mediasoup)

## Batas React ↔ game loop (WAJIB dibaca sebelum menambah state)

Dunia digambar di canvas 2D di dalam komponen React (`GameCanvas`). Itu artinya
React dan game loop berbagi satu main thread, dan setiap re-render yang tidak
perlu **memakan frame budget**. Enam penyebab "gerakan patah-patah" yang
ditemukan pada 20 Agustus 2026 semuanya bentuk yang sama: nilai yang berubah
pada laju gameplay dititipkan ke state React, lalu React dengan patuh me-render
ulang pohon yang mahal.

**Aturannya:**

> Apa pun yang berubah lebih cepat dari ~2x per detik TIDAK BOLEH hidup di state
> React, dan TIDAK BOLEH menjadi dependency dari render/effect apa pun.

Konsekuensi praktisnya:

1. **Posisi, arah, jarak, status bergerak** hidup di modul biasa di luar React —
   `stores/livePosition.ts`, `stores/remotePositions.ts`. Canvas membacanya
   imperatif tiap frame lewat ref. Jangan pindahkan kembali ke store.
2. **Pilih field, jangan objek.** `useGameStore((s) => s.localPlayer)` ikut
   re-render tiap tulisan posisi (10Hz). Pilih `s.localPlayer.name` dst.
   Biayanya tidak terlihat di tempat penulisannya — itulah kenapa ada guard test.
3. **React dipicu peristiwa, bukan nilai kontinu.** Kalau UI butuh nilai
   kontinu, berlangganan ke bentuk yang sudah dikuantisasi (tier visibility,
   boolean "sedang bicara"), bukan angkanya.
4. **Setiap prop yang melewati `memo()` harus stabil.** Satu arrow inline
   membatalkan barrier-nya sepenuhnya, tanpa peringatan apa pun.
5. **Layer statis di-cache.** Floor plan (tile/furniture/zona) digambar sekali
   per perubahan peta ke canvas offscreen, lalu di-blit. Jangan gambar ulang
   per frame karena ada objek dinamis yang bergerak di atasnya.

Aturan 2, 4, dan 5 ditegakkan oleh `tests/performanceGuards.test.ts` dan
`tests/storeSubscriptions.test.ts` — kalau salah satu gagal, jangan diakali
test-nya; nilai itu memang tidak boleh lewat sana.

Backend        : Node.js + Express + Socket.IO
Database       : PostgreSQL via Prisma ORM (users, rooms, tilemap/furniture/zones sebagai Json) + Redis untuk presence (fallback in-memory kalau Redis tidak ada)
Auth           : JWT (jsonwebtoken) + bcrypt, middleware Express custom (bukan NextAuth)
Validation     : Zod (middleware/validate.ts) + express-rate-limit
Styling        : Tailwind CSS (tema putih/ungu)
Icons          : react-bootstrap-icons (semua icon UI fungsional — badge/tombol/HUD/emote wheel — bukan emoji lagi; emoji tersisa hanya untuk hal yang secara teknis tidak bisa jadi komponen React: teks yang digambar langsung di canvas 2D, dan konten bebas seperti isi chat/status)
Monorepo       : npm workspaces (client / server / shared)
```

---

## 📁 Project Structure

```
meetkai/
├── client/                                 # React + Vite frontend
│   ├── public/assets/
│   │   ├── characters/
│   │   │   ├── generator/                  # Layered sprite parts (Bodies/Eyes/Outfits/Hairstyles/Accessories)
│   │   │   └── premade/generator-premade/  # 20 ready-made character combos + free-pack-16x16
│   │   └── tilesets/
│   │       ├── modern-interiors/
│   │       └── modern-office/              # Room_Builder + Singles (dipakai tile/furniture palette)
│   ├── src/
│   │   ├── components/
│   │   │   ├── canvas/
│   │   │   │   ├── GameCanvas.tsx          # Render loop: tiles, furniture (object+overhead layer), avatar, zona, portal
│   │   │   │   └── AvatarSprite.ts         # Dispatcher shape/layered/premade + frame animasi
│   │   │   ├── avatar/
│   │   │   │   ├── AvatarSetup.tsx         # Character-creator UI (builder + quick-pick)
│   │   │   │   ├── AvatarEditorButton.tsx
│   │   │   │   └── StatusButton.tsx        # Set status custom bebas (quick-pick + input), broadcast player:status_update
│   │   │   ├── ui/
│   │   │   │   ├── RoomEditor.tsx          # Palet visual, furniture, zona (+ form label/warna/tipe), basic types, undo/redo
│   │   │   │   ├── ChatPanel.tsx           # Tab All/Private — Private muncul otomatis saat di dalam zona
│   │   │   │   ├── VideoGrid.tsx
│   │   │   │   ├── EmoteWheel.tsx
│   │   │   │   ├── AdminPanel.tsx
│   │   │   │   ├── ParticipantPanel.tsx    # Panel kolaps: daftar peserta + status + thumbnail video (reuse remoteStreams)
│   │   │   │   ├── NameModal.tsx
│   │   │   │   └── ConnectionIndicator.tsx
│   │   │   └── hud/
│   │   │       ├── MicButton.tsx
│   │   │       ├── CameraButton.tsx
│   │   │       ├── ScreenShareButton.tsx
│   │   │       └── Minimap.tsx
│   │   ├── data/
│   │   │   ├── spriteManifest.ts           # Daftar file sprite generator (auto-generated dari folder asset)
│   │   │   └── tilePaletteManifest.ts      # Kurasi tile/furniture + koordinat crop asli
│   │   ├── hooks/
│   │   │   ├── useSocket.ts                # Semua socket event client
│   │   │   ├── useMovement.ts              # Keyboard movement + collision
│   │   │   ├── useProximity.ts             # Proximity + zone-aware membership
│   │   │   ├── useWebRTC.ts                # Connect/disconnect peer, mic/camera/screen-share toggle
│   │   │   └── useAuth.ts / useAvatarConfig.ts
│   │   ├── services/
│   │   │   ├── webrtcService.ts            # RTCPeerConnection management, screen share track-swap
│   │   │   └── api.ts                      # REST client (auth, rooms)
│   │   ├── stores/
│   │   │   └── gameStore.ts                # Zustand: satu store untuk semua state game
│   │   ├── utils/
│   │   │   ├── createDefaultRoom.ts        # Seed room default (tiles + furniture + spawn)
│   │   │   └── spriteLoader.ts             # Cached image loader + crop-draw untuk canvas
│   │   └── pages/
│   │       ├── LoginPage.tsx
│   │       └── Lobby.tsx
│
├── server/                                 # Node.js + Express + Socket.IO backend
│   ├── prisma/schema.prisma                # User, Room (tilemapData/furniture/zones sebagai Json), RoomMember
│   ├── src/
│   │   ├── socket/
│   │   │   ├── roomHandler.ts              # Join/leave, tile+furniture+zone save/load, admin grant/revoke, spawn point
│   │   │   ├── movementHandler.ts          # Broadcast posisi
│   │   │   ├── chatHandler.ts              # Chat + speech bubble
│   │   │   ├── emoteHandler.ts
│   │   │   ├── rtcHandler.ts               # Relay offer/answer/ICE candidate
│   │   │   ├── zoneHandler.ts              # Relay enter/exit zona (scoped per room)
│   │   │   └── roomSaveHandler.ts          # (legacy, tidak dipakai jalur utama)
│   │   ├── routes/
│   │   │   ├── auth.ts                     # register/login/me (JWT + bcrypt)
│   │   │   └── rooms.ts                    # CRUD room (Lobby)
│   │   ├── middleware/
│   │   │   ├── auth.ts, validate.ts (Zod), rateLimit.ts
│   │   ├── store/roomStore.ts              # Presence Redis-atau-in-memory
│   │   └── config/index.ts
│
├── shared/                                 # Tipe & konstanta bersama client-server
│   ├── types/index.ts                      # Avatar, RoomTile, Furniture, Zone, SocketEvents, konstanta grid, dst.
│   └── defaultRoomLayout.ts                # createDefaultOfficeLayout() — satu-satunya sumber layout default (dipakai server saat create room, dan client sebagai local scaffold sebelum room:state datang)
│
├── docker-compose.yml                      # Postgres + Redis untuk dev lokal
├── project.md
└── package.json                            # npm workspaces: client, server, shared
```

---

## 🔄 System Architecture
  
```
┌──────────────────────────────────────────────────────────┐
│                        BROWSER                           │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  HTML5 Canvas   │    │     React UI Overlay      │    │
│  │  (Game World)   │    │  Chat / Video / HUD       │    │
│  └────────┬────────┘    └───────────┬──────────────┘    │
│           │                         │                    │
│           └────────────┬────────────┘                    │
│                        │                                 │
│              ┌─────────▼──────────┐                     │
│              │   State Manager    │                     │
│              │   (Zustand Store)  │                     │
│              └─────────┬──────────┘                     │
└────────────────────────┼─────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │    Socket.IO        │◄──── Movement, Chat, Presence
              │    WebSocket        │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   Node.js Server    │
              │   + Redis (State)   │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   PostgreSQL DB     │
              │   Users, Rooms,     │
              │   Room Objects      │
              └─────────────────────┘

Terpisah:
Browser A ◄──── WebRTC P2P ────► Browser B
         (Audio/Video langsung antar peer)
```

---

## 📡 Socket Events

Daftar lengkap ada di `SocketEvents` enum (`shared/types/index.ts`) — dipakai bersama oleh client & server, jadi nama event tidak pernah salah ketik di satu sisi.

```typescript
// Room lifecycle
room:join → room:state (players, tiles, furniture, zones, adminUserIds, masterAdminUserId)
room:leave
player:joined / player:left
player:move → player:moved   |   player:stop → player:stopped

// Avatar
avatar:update → avatar:updated
player:status_update → player:status_updated   // status custom bebas, badge di atas nametag

// Chat & emote
chat:message → chat:broadcast    // chat:message bisa bawa zoneId opsional (private ke zona) → chat:broadcast hanya ke socket yang tercatat di zona itu + pengirim
chat:bubble                      // speech bubble di atas avatar
emote:play

// Zona privat (proteksi A/V dihitung client-side; event ini cuma relay untuk UI lain)
zone:enter / zone:exit           // di-scope per room di server, juga dipakai untuk routing chat:message per-zona

// WebRTC signaling (P2P, server cuma relay)
rtc:offer / rtc:answer / rtc:ice-candidate

// Room editor (tile + furniture + zona dikirim sekaligus, lihat RoomUpdatePayload)
room:update → room:updated       // disimpan ke Prisma Room.tilemapData/furniture/zones

// Admin
admin:grant / admin:revoke → admin:changed

// Room management (dari Lobby)
room:delete → room:deleted
lobby:room_updated / lobby:room_removed   // player count & penghapusan room live di Lobby
```

---

## 🗺️ Development Roadmap (Phased)

### Phase 1 — Foundation
- [x] Setup project (React + Node + Socket.IO, npm workspaces)
- [x] Canvas rendering (grid/tilemap)
- [x] Avatar movement (keyboard-controlled, WASD/Arrow)
- [x] Multi-user position sync via Socket.IO
- [x] Basic avatar customization (color, name)

### Phase 2 — Room System
- [x] Room tilemap dengan tile types (wall, floor, door, desk, chair, portal, spawn)
- [x] Room objects (furniture multi-cell dari tileset asli: meja, kursi, sofa, lemari, tanaman, dst)
- [x] Collision detection
- [x] Multiple rooms + room switching (via tile portal + slug room)

### Phase 3 — Audio/Video (WebRTC)
- [x] Mic toggle & camera toggle
- [x] Proximity detection radius
- [x] WebRTC signaling via Socket.IO (P2P murni, tanpa SFU)
- [x] Audio volume scaling berdasarkan jarak (dan gain penuh di dalam zona privat)
- [x] Video grid overlay (saat berdekatan / satu zona)

### Phase 4 — Advanced Features
- [x] Room editor / builder — palet visual (tekstur lantai + furniture asli, bukan hanya tipe generik)
- [x] Sprite pixel-art layered (body/eyes/outfit/hair/accessory) + opsi karakter premade
- [x] Emotes & reactions (emote wheel radial)
- [x] Screen sharing (getDisplayMedia + track replace, HUD button)
- [x] Private zones (meeting room) — restriksi A/V otomatis berbasis zona, bukan cuma jarak
- [x] Persistent room config (Prisma: tilemapData, furniture, zones sebagai Json)

### Phase 5 — Production
- [x] Auth (login / register via JWT + bcrypt)
- [x] User profiles (avatarConfig tersimpan per user)
- [x] Admin panel (master admin dari pemilik room, grant/revoke admin biasa)
- [ ] Mobile-responsive UI (belum, layout saat ini didesain untuk desktop)
- [ ] Performance optimization (large rooms) — belum diuji untuk banyak pemain sekaligus

### Phase 6 — Fitur ala ZEP (Zona Berlabel, Status, Chat Per-Zona, Panel Peserta)
- [x] Zona berlabel — `Zone.label/color/type`, banner DOM overlay (bukan canvas) untuk tipe `meeting`, pill kecil untuk `desk`/`focus`, form di RoomEditor saat membuat zona baru
- [x] Status custom — `Avatar.status` (bebas, 24 char), tombol cepat dekat Edit Avatar, broadcast via `player:status_update`, badge ungu di atas nametag (terpisah dari `avatarConfig.statusTag` yang lama)
- [x] Chat per-zona — `ChatMessage.zoneId`, tab All/Private di ChatPanel (Private muncul otomatis saat masuk zona), server rutekan pesan berzona hanya ke socket yang tercatat `zone:enter` di zona yang sama (`zoneHandler.getSocketIdsInZone`)
- [x] Panel peserta — `ParticipantPanel.tsx` (komponen baru, terpisah dari `AdminPanel.tsx`), daftar semua peserta online + status, thumbnail video utk hingga 3 peserta yang sedang video call (reuse `remoteStreams`/`webrtcService`, tidak membuat koneksi WebRTC baru), indikator "+N" untuk sisa yang video-aktif, toggle kolaps/expand

### Phase 7 — Bootstrap Icons & Perbaikan Denah
- [x] Semua icon UI fungsional (badge admin, HUD mic/camera/screen-share, chat, status, avatar editor, room editor, emote wheel, participant panel, lobby) diganti dari emoji ke `react-bootstrap-icons`. Emoji yang SENGAJA dipertahankan: teks yang digambar di canvas 2D (`GameCanvas.tsx` — nametag crown/mute/speaking/camera icon, bubble emote — Bootstrap Icons adalah komponen React/SVG, tidak bisa dipakai di `ctx.fillText`), dan konten bebas seperti palet emoji chat (`ChatPanel.tsx`) serta contoh nilai status cepat (`StatusButton.tsx`) yang memang dikirim sebagai teks biasa
- [x] Tile `door` dan `wall` sama-sama diperbaiki source rect-nya di `GameCanvas.tsx` — lihat catatan bug di bawah
- [x] Layout default (`shared/defaultRoomLayout.ts`) dipecah jadi 2 "desk zone" terpisah (bukan cuma cluster meja di lantai terbuka), dihubungkan lorong 2-tile lewat dinding baru di x=10, selain Meeting Room dan Lounge yang sudah ada
- [x] Variasi tekstur lantai: 2 tekstur baru dikurasi (`floor-tile-gray`, `floor-brown-weave`, keduanya diverifikasi seamless lewat render 4x4) — tiap area sekarang beda: Desk Zone A (lantai default), Desk Zone B (gray tile), Lounge (brown weave — sebelumnya pakai tekstur yang SAMA dengan lantai default, jadi tidak pernah benar-benar beda), Meeting Room (maroon carpet)
- [x] Dekorasi tambahan: pinboard (Desk Zone B) + tanaman baru di sudut-sudut yang tadinya kosong (kedua desk zone, meeting room, lounge)

### Phase 8 — Banner Dekoratif, Fix Hapus Room, Kamera Tidak Mirror
- [x] Banner/signage dekoratif — `Furniture.kind === 'banner'` (+ `text`/`textColor`/`bgColor`/`imageUrl`), ditaruh admin lewat Room Editor (tombol "Add Banner" → klik tile → form warna/teks/lebar), dirender sebagai DOM overlay sama seperti label zona, murni dekorasi (tidak block movement, bisa ditaruh di atas tile apapun termasuk wall)
- [x] Hapus room diperkeras: state konfirmasi 2-langkah sekarang jelas secara visual (card memerah + teks peringatan eksplisit, bukan cuma dua link kecil), notifikasi "room dihapus" untuk user yang sedang di dalamnya diganti dari `alert()`+`window.location.reload()` (jeda 3 detik, terasa macet) jadi navigasi React state langsung ke Lobby + banner overlay yang jelas, mirip alur tombol "Leave" yang sudah ada
- [x] Video call dipastikan tidak pernah mirror — diaudit, tidak ada `scaleX(-1)`/flip di manapun (`VideoGrid.tsx`, `ParticipantPanel.tsx`, `webrtcService.ts`), ditambahkan `style={{ transform: 'none' }}` eksplisit di preview lokal biar tidak mungkin ke-flip oleh CSS lain secara tidak sengaja

### Belum dikerjakan / follow-up yang diketahui
- [ ] Karakter premade bernama (Adam/Alex/Amelia/Bob dari `free-pack-16x16`) — dipakai `generator-premade` sebagai gantinya karena format frame-nya beda dan belum direverse-engineer
- [ ] Undo/redo Room Editor belum mencakup furniture, `floorPaletteId`, atau `portalTarget` (hanya tipe tile dasar)
- [ ] Belum ada rotate/drag-pindah furniture setelah ditempatkan
- [ ] Belum ada notifikasi UI saat pemain lain masuk/keluar zona (event server sudah ada, tinggal disambung ke toast)
- [ ] Panel Peserta belum ada tombol aksi per-peserta (mis. mute/pin) — murni display, sesuai lingkup fitur ini
- [ ] Wall auto-tile: `wall` sekarang pakai satu tekstur bata datar untuk semua sisi (tidak ada varian sudut/T-junction/ujung) — cukup untuk membedakan dinding dari lantai, tapi bukan autotile penuh
- [ ] Banner `imageUrl` adalah URL biasa (admin paste link), bukan upload file — tidak ada endpoint/storage upload di server, di luar lingkup Phase 8
- [ ] Avatar belum punya pose duduk khusus (baik shape/layered maupun premade) — saat duduk avatar dirender idle diam (bukan walk-cycle), bukan sprite "sitting" tersendiri
- [ ] Direction avatar cuma ter-update sebagai efek samping dari gerakan sungguhan (`onMove` cuma jalan kalau posisi berubah) — kalau berdiri PAS menempel furniture lalu menekan arah ke sana tanpa ruang gerak, arah hadap tidak berubah (tidak masalah untuk gameplay normal karena mendekat pasti sudah menggerakkan avatar dulu, tapi jadi hal yang perlu diperhitungkan untuk fitur interaksi berbasis arah-hadap berikutnya)

### Phase 9 — Perkuat Auto-Login (Persistent Session)
- [x] `JWT_EXPIRES_IN` default dinaikkan dari `7d` ke `30d` (tetap lewat env var, `server/.env`/`.env.example`/`server/.env.example`) — lihat root cause di bawah untuk kenapa 7 hari adalah penyebab utamanya
- [x] Sliding-expiry refresh: `GET /auth/me` (`server/src/routes/auth.ts`) sekarang mengembalikan `token` baru di response kalau token yang dipakai sudah dalam 3 hari terakhir masa berlakunya (`REFRESH_THRESHOLD_SECONDS`) — `middleware/auth.ts` diperluas supaya menyimpan `exp` claim token (`AuthRequest.tokenExp`) tanpa mengubah signature `verifyToken()` yang sudah dipakai socket handshake. Client (`useAuth.ts`) otomatis menyimpan token baru itu ke `localStorage` kalau ada. Efeknya: user yang buka app minimal sebulan sekali praktis tidak akan pernah lihat sesi habis
- [x] Pesan "Your session has expired. Please log in again." (beda styling — amber, bukan merah — dari error login biasa) muncul di `LoginPage.tsx` kalau auto-login saat mount gagal karena token benar-benar ditolak server (401/403/404), BUKAN karena masalah jaringan. `client/src/services/api.ts` dapat class `ApiError` baru (bawa `status` code) supaya `useAuth.ts` bisa membedakan keduanya
- [x] Verifikasi: loading-gate (`if (loading) ... if (!user) ...` di `App.tsx`) sudah benar sejak awal — tidak ada flash LoginPage sebelum auto-login selesai diproses, jadi tidak perlu perbaikan di titik ini
- [x] (Opsional) "Continue where you left off" — slug room terakhir disimpan di `localStorage` (`vm_last_room_slug`) tiap kali `roomSlug` berubah; Lobby menampilkan banner "Rejoin {nama room}" kalau room itu masih ada di daftar room publik saat ini (room yang sudah dihapus otomatis tidak ditawarkan lagi)

### Bug ditemukan & diperbaiki saat build Phase 6
- Nama pemain lain tampil sebagai "You" alih-alih nama asli, untuk siapa pun yang belum pernah membuka Avatar Editor. Penyebab: `avatarConfig.name` (default placeholder `'You'` untuk live-preview editor) diprioritaskan di atas display name asli saat broadcast `player:joined` (`server/src/socket/roomHandler.ts`) dan saat seed `AvatarSetup` di `Game` (`client/src/App.tsx`). Ditemukan lewat test dua-user nyata untuk verifikasi Panel Peserta — baru pertama kali dua akun berbeda diuji bersamaan dalam sesi ini. Diperbaiki dengan membalik prioritas (nama akun asli menang).

### Bug ditemukan & diperbaiki saat build Phase 7
- **Tile `wall` tidak pernah punya tekstur visual — sama sekali transparan.** `TILE_SPRITES.wall` di `GameCanvas.tsx` menunjuk ke koordinat (0,0) di `Room_Builder_Office_32x32.png`, dan sel itu 100% transparan (diverifikasi dengan render sel itu di atas background magenta). Karena lantai selalu digambar dulu sebelum wall, dinding manapun — border map maupun partisi — selama ini terlihat identik dengan lantai kosong walau collision-nya tetap berfungsi (avatar tetap tidak bisa menembus). Ini kemungkinan besar penyebab utama kesan "kotak-kotak"/ruang kosong dari awal, bukan cuma kurang furniture. Diperbaiki dengan pindah ke (0, 320) di sheet yang sama — tekstur bata solid yang sudah diverifikasi opaque penuh.
- **Tile `door` menampilkan garis putih tipis vertikal**, bukan objek pintu utuh. Sumbernya crop di kolom 7 baris 1 — potongan itu ternyata cuma separuh dari grafik pintu 2-tile-lebar di sheet tsb (sebagian besar transparan, hanya sisa tipis dinding di satu sisi). Diperbaiki dengan pindah ke kolom 8 baris 0 — satu tile penuh berupa panel pintu solid gelap.
- Ditemukan dengan cara yang sama seperti bug wall di atas: render sel sumber di atas background magenta lewat halaman HTML sementara + Playwright screenshot, sebelum dipakai di kode — bukan menebak dari nama file.

### Bug ditemukan & diperbaiki saat build Phase 8
- **Hapus room gagal total dengan error FK constraint** (`Foreign key constraint violated: RoomMember_roomId_fkey`, kode Prisma P2003) — ditemukan lewat test hapus-room dua-user nyata. Constraint `RoomMember.roomId` di database lokal masih `ON DELETE RESTRICT`, padahal `schema.prisma` sudah `onDelete: Cascade` dan migration `20260705150647_roommember_cascade_delete` yang memperbaikinya SUDAH ada di repo — migration itu cuma belum pernah dijalankan ke database dev lokal (`prisma migrate status` menunjukkan 2 migration yang belum applied). Bukan bug kode baru, murni environment lokal yang belum disinkron; diperbaiki dengan `npx prisma db push`. **Penting**: kalau environment lain (staging/production) juga belum menjalankan migration ini, delete room akan gagal dengan cara yang sama — pastikan `prisma migrate deploy` (atau setara) jalan sebagai bagian dari proses deploy.
- Notifikasi hapus-room untuk user yang sedang di dalam room memakai `alert()` blocking + `window.location.reload()` dengan jeda 3 detik — user sempat terlihat "macet" di canvas basi sebelum reload benar-benar terjadi. Diganti dengan state Zustand (`roomDeletedNotice`) yang diwatch oleh komponen `Game` dan menavigasi balik ke Lobby lewat cara yang sama seperti tombol "Leave" (React state, tanpa reload halaman).

### Audit Phase 9 — root cause "auto-login terasa tidak reliable"
Tiga hipotesis awal dicek satu-satu; hasilnya cuma SATU yang benar-benar terjadi di
codebase ini:
- **JWT_SECRET berubah antar restart?** Tidak. `.env` lokal dan `docker-compose.yml`
  (`JWT_SECRET: ${JWT_SECRET:?...}`, fail-fast kalau belum di-set) sama-sama membaca dari
  env var yang persist, bukan digenerate ulang tiap start. Bahkan fallback default di kode
  (`dev-secret-change-in-production`) adalah string literal tetap, bukan random — jadi
  secret memang stabil di setup ini. (Tetap ditemukan: `.env` lokal MENYIMPAN literal
  string default itu apa adanya alih-alih secret asli — bukan penyebab masalah restart,
  tapi tetap risiko keamanan kalau ke-commit/dipakai di luar dev.)
- **User record hilang karena in-memory store yang reset?** Tidak, untuk data user/auth.
  `/auth/me` query langsung ke Postgres via Prisma (`prisma.user.findUnique`), dan
  `docker-compose.yml` sudah pakai named volume (`pgdata`) yang persist antar restart
  container. (Catatan: `roomStore.ts` MEMANG punya fallback in-memory, tapi itu untuk data
  presence/posisi pemain real-time, bukan akun — di luar cakupan auto-login.) Ditambahkan
  log `console.warn` eksplisit di `/auth/me` untuk skenario token valid tapi `userId` tidak
  ketemu di DB, supaya kalau ini TERJADI di environment lain, gampang ke-diagnosis dari log
  server, bukan disangka bug JWT.
- **Race condition bikin LoginPage flash sebelum auto-login selesai?** Tidak. `App.tsx`
  sudah benar: `if (loading) return <Loading/>` dicek SEBELUM `if (!user) return
  <LoginPage/>`, dan `loading` baru `false` setelah `getMe()` selesai (`finally`). Terverifikasi lewat pembacaan kode, tidak perlu diubah.
- **Root cause sebenarnya: kombinasi masa berlaku token 7 hari + tidak ada refresh + tidak
  ada feedback saat sesi habis.** Karena `getMe()` cuma dipanggil sekali saat mount, tidak
  ada yang memperpanjang sesi user yang aktif — begitu 7 hari lewat, `localStorage` token
  dihapus diam-diam dan user cuma melihat form login kosong tanpa penjelasan, gampang
  disangka "auto-login-nya emang belum jalan" padahal sesi memang sudah kedaluwarsa secara
  sah. Ini penyebab yang paling masuk akal untuk keluhan "auto login nggak reliable", dan
  yang diperbaiki lewat Phase 9 di atas (masa berlaku lebih panjang + sliding refresh +
  pesan eksplisit saat benar-benar habis).

### Phase 10 — Fix Panel Putih Glitch, Fitur Duduk, Perbanyak Aset Room Editor
- [x] Panel putih kosong di pojok kanan bawah — ternyata BUKAN elemen terpisah yang glitch, itu `Minimap` yang render tepat di ukuran & posisi yang benar (150x100px), tapi ditempatkan SEJAJAR dengan tombol Chat collapsed (bukan bertumpuk di atasnya) sehingga latar nyaris-putihnya menyatu visual dengan tombol Chat jadi terlihat seperti satu kotak besar kosong. `ChatPanel.tsx` sendiri sudah benar (panel besarnya betul-betul unmount saat collapsed, bukan cuma di-resize). Diperbaiki dengan memindah Minimap ke atas tombol Chat (bertumpuk, ada jarak) dan memberi warna latar ungu muda + border lebih jelas biar gampang dikenali sebagai minimap
- [x] Fitur duduk di kursi — `Furniture.isInteractable` (otomatis `true` untuk entry berlabel `sittable` di `tilePaletteManifest.ts`, sekarang cuma `chair-office`), `Avatar.isSitting`. Player yang menghadap tepat ke kursi interaktif lihat indikator "🪑 SPACE to sit" mengambang; SPACE men-snap posisi ke kursi, membekukan WASD (`useMovement`'s `isFrozen`), dan menghadapkan avatar ke arah berlawanan dari kursi (menghadap keluar ruangan). Menekan tombol gerak apa pun sambil duduk otomatis berdiri dan kembali ke posisi sebelum duduk (`sitReturnPos` di gameStore, supaya tidak nyangkut di tile kursi yang collision-blocked). Disinkron ke pemain lain lewat `player:sit`/`player:sat` (server relay + simpan ke `roomStore`, pola sama seperti `player:status_update`), diverifikasi dengan test dua-browser sungguhan
- [x] Palet Room Editor diperluas dari 11 furniture polos jadi 3 tab berkategori (Furniture/Decor/Electronics, ~29 item total) dengan thumbnail gambar asli (bukan swatch warna) — semua bounding box baru dihitung terprogram (render tiap source file ke canvas, scan alpha channel) bukan ditebak dari nama file, gaya yang sama seperti perbaikan bug wall/floor sebelumnya

---

## ⚙️ Environment Variables

Lihat `.env.example` di root untuk daftar lengkap & nilai default dev:

```env
NODE_ENV=development
PORT=3001

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kaispace
REDIS_URL=redis://localhost:6379          # opsional — fallback ke in-memory kalau tidak connect

JWT_SECRET=change-this-to-a-random-string
JWT_EXPIRES_IN=7d

CORS_ORIGIN=http://localhost:5173
CLIENT_URL=http://localhost:5173

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
```

Client saat ini connect langsung ke `http://localhost:3001` (hardcoded di `useSocket.ts` dan `Lobby.tsx`, bypass proxy Vite untuk menghindari isu WebSocket proxy) — belum pakai env var `VITE_*` terpisah.

---

## 🧮 Constants & Game Config

```typescript
// shared/types/index.ts — nilai aktual yang dipakai kode, bukan aspirasional
export const TILE_SIZE = 32
export const MAP_WIDTH = 30                    // tiles
export const MAP_HEIGHT = 20                   // tiles
export const PLAYER_SPEED = 150                // px per detik

export const PROXIMITY_THRESHOLD = 3           // tiles — di dalam 3 tile: audio+video nyambung
export const PROXIMITY_THRESHOLD_PX = 96       // 3 tile × 32px
export const DISCONNECT_DEBOUNCE_MS = 500      // delay sebelum diskoneksi WebRTC saat keluar radius

// Room.maxPlayers (Prisma) default 50 per room — bukan konstanta shared, field per-row di DB
```

---

## 👥 Kontributor & Notes

- Inspired by: [Gather.town](https://gather.town), [Zep.us](https://zep.us)
- Target: Browser-based, no install required
- Priority: Low latency movement sync + reliable WebRTC
- Aset pixel-art: LimeZu "Modern Interiors" & "Modern Office" (tileset + Character Generator), lisensi commercial perlu dicek terpisah sebelum publish produk final

---

*Last updated: 2026-07-06 | Status: Fitur inti (Phase 1–5) + fitur ala ZEP (Phase 6) + Bootstrap Icons & perbaikan denah (Phase 7) + banner dekoratif, fix hapus room, kamera tidak mirror (Phase 8) + auto-login diperkuat (Phase 9) + fix minimap glitch, fitur duduk, palet Room Editor diperluas (Phase 10) selesai — lihat "Belum dikerjakan / follow-up" untuk sisa pekerjaan diketahui*