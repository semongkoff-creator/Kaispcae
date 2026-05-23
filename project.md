# 🗺️ VirtualMeet — Interactive Meeting System
> *Inspired by Gather.town & Zep.us — A 2D avatar-based virtual meeting space*

---

## 📌 Project Overview

**VirtualMeet** adalah sistem meeting interaktif berbasis browser di mana setiap peserta memiliki avatar 2D yang dapat bergerak bebas di dalam ruangan virtual yang bisa di-kustomisasi. Pengguna bisa berjalan mendekati satu sama lain untuk memicu interaksi audio/video secara otomatis (proximity-based interaction), mirip seperti percakapan nyata.

---

## 🎯 Core Features

| Feature | Deskripsi |
|---|---|
| 🧍 Avatar System | Avatar 2D per user, bisa di-kustomisasi (warna, nama, karakter) |
| 🗺️ Room Builder | Ruangan bisa dikonfigurasi: tile-based map, furniture, zona |
| 🚶 Movement | Avatar bisa bergerak dengan keyboard (WASD / Arrow keys) |
| 🎙️ Proximity Audio | Mic/speaker aktif otomatis jika avatar saling berdekatan |
| 🎥 Video Call | Video muncul saat avatar dalam radius tertentu |
| 💬 Chat & Emote | Chat bubble di atas avatar, emote/reaksi |
| 🏠 Room Customization | Admin bisa atur layout ruangan, tambah objek, zona meeting |
| 👤 User Auth | Login, profil, pengaturan avatar |

---

## 🏗️ Tech Stack

```
Frontend       : React + TypeScript
Rendering      : HTML5 Canvas (atau Phaser.js untuk game engine ringan)
Real-time      : Socket.IO (WebSocket)
Audio/Video    : WebRTC (peer-to-peer) + mediasoup / daily.co / livekit
Backend        : Node.js + Express
Database       : PostgreSQL (users, rooms) + Redis (presence/state)
Auth           : JWT / NextAuth
Styling        : Tailwind CSS
```

---

## 📁 Project Structure

```
virtualMeet/
├── client/                        # React Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── canvas/
│   │   │   │   ├── GameCanvas.tsx        # Main canvas renderer
│   │   │   │   ├── AvatarSprite.tsx      # Avatar rendering
│   │   │   │   └── RoomTilemap.tsx       # Room/map rendering
│   │   │   ├── ui/
│   │   │   │   ├── AvatarCustomizer.tsx  # Avatar editor
│   │   │   │   ├── RoomEditor.tsx        # Room builder UI
│   │   │   │   ├── ChatPanel.tsx         # Chat sidebar
│   │   │   │   └── VideoGrid.tsx         # Active video calls
│   │   │   └── hud/
│   │   │       ├── MicButton.tsx
│   │   │       ├── EmoteBar.tsx
│   │   │       └── Minimap.tsx
│   │   ├── hooks/
│   │   │   ├── useSocket.ts              # Socket.IO connection
│   │   │   ├── useMovement.ts            # Keyboard movement
│   │   │   ├── useProximity.ts           # Proximity detection
│   │   │   └── useWebRTC.ts              # Audio/video calls
│   │   ├── store/
│   │   │   ├── roomStore.ts              # Room state (Zustand)
│   │   │   ├── userStore.ts              # User/avatar state
│   │   │   └── callStore.ts              # Active calls state
│   │   ├── types/
│   │   │   ├── avatar.ts
│   │   │   ├── room.ts
│   │   │   └── socket.ts
│   │   └── pages/
│   │       ├── Lobby.tsx
│   │       ├── Room.tsx
│   │       └── AvatarSetup.tsx
│
├── server/                        # Node.js Backend
│   ├── src/
│   │   ├── socket/
│   │   │   ├── roomHandler.ts            # Room join/leave events
│   │   │   ├── movementHandler.ts        # Position broadcasts
│   │   │   └── callHandler.ts            # WebRTC signaling
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── rooms.ts
│   │   │   └── users.ts
│   │   ├── models/
│   │   │   ├── User.ts
│   │   │   ├── Room.ts
│   │   │   └── RoomObject.ts
│   │   └── services/
│   │       ├── proximityService.ts       # Calculate who is near who
│   │       └── rtcService.ts             # WebRTC session management
│
├── shared/                        # Shared types between client & server
│   └── types/
│       ├── events.ts                     # Socket event names & payloads
│       └── constants.ts                  # Grid size, proximity radius, etc.
│
├── PROJECT.md
├── package.json
└── README.md
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

```typescript
// CLIENT → SERVER
socket.emit('player:move', { x, y, direction })
socket.emit('player:emote', { emoteId })
socket.emit('chat:send', { message, roomId })
socket.emit('rtc:offer', { targetId, offer })
socket.emit('rtc:answer', { targetId, answer })
socket.emit('rtc:ice-candidate', { targetId, candidate })

// SERVER → CLIENT
socket.on('room:state', { players, objects })
socket.on('player:joined', { player })
socket.on('player:moved', { id, x, y, direction })
socket.on('player:left', { id })
socket.on('proximity:enter', { nearbyIds })
socket.on('proximity:exit', { farIds })
socket.on('chat:receive', { senderId, message })
socket.on('rtc:offer', { fromId, offer })
socket.on('rtc:answer', { fromId, answer })
socket.on('rtc:ice-candidate', { fromId, candidate })
```

---

## 🗺️ Development Roadmap (Phased)

### Phase 1 — Foundation
- [ ] Setup project (React + Node + Socket.IO)
- [ ] Canvas rendering (grid/tilemap)
- [ ] Avatar movement (keyboard-controlled)
- [ ] Multi-user position sync via Socket.IO
- [ ] Basic avatar customization (color, name)

### Phase 2 — Room System
- [ ] Room tilemap dengan tile types (wall, floor, door, desk)
- [ ] Room objects (chairs, tables, whiteboards)
- [ ] Collision detection
- [ ] Multiple rooms + room switching

### Phase 3 — Audio/Video (WebRTC)
- [ ] Mic toggle (push-to-talk atau auto)
- [ ] Proximity detection radius
- [ ] WebRTC signaling via Socket.IO
- [ ] Audio volume scaling berdasarkan jarak
- [ ] Video grid overlay (saat berdekatan)

### Phase 4 — Advanced Features
- [ ] Room editor / builder (drag & drop objects)
- [ ] Custom avatar sprites / upload
- [ ] Emotes & reactions
- [ ] Screen sharing
- [ ] Private zones (meeting room)
- [ ] Persistent room config (database)

### Phase 5 — Production
- [ ] Auth (login / register)
- [ ] User profiles
- [ ] Admin panel
- [ ] Mobile-responsive UI
- [ ] Performance optimization (large rooms)

---

## ⚙️ Environment Variables

```env
# Server
PORT=3001
DATABASE_URL=postgresql://user:pass@localhost:5432/virtualmeet
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_jwt_secret

# Client
VITE_SERVER_URL=http://localhost:3001
VITE_ICE_SERVERS=stun:stun.l.google.com:19302
```

---

## 🧮 Constants & Game Config

```typescript
// shared/constants.ts
export const TILE_SIZE = 32           // px per tile
export const PLAYER_SPEED = 3         // tiles per move
export const PROXIMITY_RADIUS = 150   // px radius untuk trigger audio
export const VIDEO_RADIUS = 100       // px radius untuk trigger video
export const MAX_PLAYERS_PER_ROOM = 50
export const DEFAULT_ROOM_WIDTH = 30  // tiles
export const DEFAULT_ROOM_HEIGHT = 20 // tiles
```

---

## 👥 Kontributor & Notes

- Inspired by: [Gather.town](https://gather.town), [Zep.us](https://zep.us)
- Target: Browser-based, no install required
- Priority: Low latency movement sync + reliable WebRTC

---

*Last updated: 2026 | Status: In Development*