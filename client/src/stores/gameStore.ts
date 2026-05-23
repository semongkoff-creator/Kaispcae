import { create } from 'zustand';
import { Avatar, RoomTile, RoomState } from '@virtualmeet/shared';

interface GameState {
  // Local player
  localPlayer: Avatar;
  setLocalPlayer: (player: Partial<Avatar>) => void;

  // Remote players
  players: Avatar[];
  addPlayer: (player: Avatar) => void;
  removePlayer: (id: string) => void;
  updatePlayerPosition: (id: string, x: number, y: number, direction: Avatar['direction']) => void;

  // Room tiles
  tiles: RoomTile[][];
  setTiles: (tiles: RoomTile[][]) => void;

  // Room meta
  roomId: string;
  roomName: string;

  // Connection
  isConnected: boolean;
  setConnected: (connected: boolean) => void;

  // Full sync
  setRoomState: (state: RoomState) => void;
}

export const useGameStore = create<GameState>((set) => ({
  localPlayer: {
    id: 'local',
    name: 'You',
    x: 80,
    y: 64,
    direction: 'down',
    color: '#ff6b6b',
    isMoving: false,
  },
  setLocalPlayer: (partial) =>
    set((state) => ({
      localPlayer: { ...state.localPlayer, ...partial },
    })),

  players: [],
  addPlayer: (player) =>
    set((state) => ({
      players: [...state.players.filter((p) => p.id !== player.id), player],
    })),
  removePlayer: (id) =>
    set((state) => ({
      players: state.players.filter((p) => p.id !== id),
    })),
  updatePlayerPosition: (id, x, y, direction) =>
    set((state) => ({
      players: state.players.map((p) =>
        p.id === id ? { ...p, x, y, direction, isMoving: true } : p,
      ),
    })),

  tiles: [],
  setTiles: (tiles) => set({ tiles }),

  roomId: 'default',
  roomName: 'Default Room',

  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  setRoomState: (roomState) =>
    set({
      roomId: roomState.id,
      roomName: roomState.name,
      tiles: roomState.tiles,
      players: roomState.players.filter((p) => p.id !== 'local'),
    }),
}));
