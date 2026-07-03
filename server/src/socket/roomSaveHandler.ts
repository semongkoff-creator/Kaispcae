import { Server, Socket } from 'socket.io';
import { SocketEvents, RoomData, RoomTile, TileType } from '@virtualmeet/shared';
import { addPlayer, getRoomState } from '../store/roomStore';

const savedRooms = new Map<string, RoomData>();

export function registerRoomSaveHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.ROOM_SAVE, (data: RoomData) => {
    savedRooms.set(data.id, data);
    console.log(`[room] saved room: ${data.name}`);
    io.emit(SocketEvents.ROOM_LOADED, data);
  });
}

export function getSavedRoom(id: string): RoomData | undefined {
  return savedRooms.get(id);
}
