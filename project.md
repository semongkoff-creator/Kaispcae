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

---

## 🏗️ Tech Stack

```
Frontend       : React + TypeScript + Vite
State          : Zustand (gameStore)
Rendering      : HTML5 Canvas — sprite/tileset rendering ditulis manual (bukan game engine)
Real-time      : Socket.IO (WebSocket)
Audio/Video    : WebRTC peer-to-peer murni (RTCPeerConnection langsung, tanpa SFU/mediasoup)
Backend        : Node.js + Express + Socket.IO
Database       : PostgreSQL via Prisma ORM (users, rooms, tilemap/furniture/zones sebagai Json) + Redis untuk presence (fallback in-memory kalau Redis tidak ada)
Auth           : JWT (jsonwebtoken) + bcrypt, middleware Express custom (bukan NextAuth)
Validation     : Zod (middleware/validate.ts) + express-rate-limit
Styling        : Tailwind CSS (tema putih/ungu)
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
│   │   │   │   └── AvatarEditorButton.tsx
│   │   │   ├── ui/
│   │   │   │   ├── RoomEditor.tsx          # Palet visual, furniture, zona, basic types, undo/redo
│   │   │   │   ├── ChatPanel.tsx
│   │   │   │   ├── VideoGrid.tsx
│   │   │   │   ├── EmoteWheel.tsx
│   │   │   │   ├── AdminPanel.tsx
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
│   └── types/index.ts                      # Avatar, RoomTile, Furniture, Zone, SocketEvents, konstanta grid, dst.
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

// Chat & emote
chat:message → chat:broadcast
chat:bubble                      // speech bubble di atas avatar
emote:play

// Zona privat (proteksi A/V dihitung client-side; event ini cuma relay untuk UI lain)
zone:enter / zone:exit           // di-scope per room di server

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

### Belum dikerjakan / follow-up yang diketahui
- [ ] Karakter premade bernama (Adam/Alex/Amelia/Bob dari `free-pack-16x16`) — dipakai `generator-premade` sebagai gantinya karena format frame-nya beda dan belum direverse-engineer
- [ ] Undo/redo Room Editor belum mencakup furniture, `floorPaletteId`, atau `portalTarget` (hanya tipe tile dasar)
- [ ] Belum ada rotate/drag-pindah furniture setelah ditempatkan
- [ ] Belum ada notifikasi UI saat pemain lain masuk/keluar zona (event server sudah ada, tinggal disambung ke toast)

---

## ⚙️ Environment Variables

Lihat `.env.example` di root untuk daftar lengkap & nilai default dev:

```env
NODE_ENV=development
PORT=3001

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/virtualmeet
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

*Last updated: 2026-07-03 | Status: Fitur inti (Phase 1–5) selesai — lihat "Belum dikerjakan / follow-up" untuk sisa pekerjaan diketahui*