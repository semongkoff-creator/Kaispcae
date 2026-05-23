// Direction the avatar is facing or moving
export type Direction = 'up' | 'down' | 'left' | 'right';

// Represents a player avatar in the virtual space
export interface Avatar {
  id: string;
  name: string;
  x: number;
  y: number;
  direction: Direction;
  color: string;
  isMoving: boolean;
}

// A single tile on the room grid
export interface RoomTile {
  x: number;
  y: number;
  type: TileType;
}

// Valid tile types and their visual/semantic meaning
export type TileType = 'floor' | 'wall' | 'door' | 'desk' | 'chair';

// Full room state transmitted over the network
export interface RoomState {
  id: string;
  name: string;
  tiles: RoomTile[][];
  players: Avatar[];
}

// All socket event names used between client and server
export enum SocketEvents {
  // Connection
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',

  // Room
  JOIN_ROOM = 'room:join',
  ROOM_STATE = 'room:state',
  LEAVE_ROOM = 'room:leave',

  // Movement
  PLAYER_MOVE = 'player:move',
  PLAYER_MOVED = 'player:moved',
  PLAYER_STOP = 'player:stop',
  PLAYER_STOPPED = 'player:stopped',

  // Presence
  PLAYER_JOINED = 'player:joined',
  PLAYER_LEFT = 'player:left',

  // Chat
  CHAT_MESSAGE = 'chat:message',
  CHAT_BROADCAST = 'chat:broadcast',
}

// Grid and rendering constants — shared so server can also validate bounds
export const TILE_SIZE = 32;
export const MAP_WIDTH = 30;
export const MAP_HEIGHT = 20;
export const PLAYER_SPEED = 150; // pixels per second
