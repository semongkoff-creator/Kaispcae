import { Server, Socket } from 'socket.io';
import { SocketEvents, RtcSignal } from '@virtualmeet/shared';

export function registerRtcHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.RTC_OFFER, (signal: RtcSignal) => {
    io.to(signal.toId).emit(SocketEvents.RTC_OFFER, signal);
  });

  socket.on(SocketEvents.RTC_ANSWER, (signal: RtcSignal) => {
    io.to(signal.toId).emit(SocketEvents.RTC_ANSWER, signal);
  });

  socket.on(SocketEvents.RTC_ICE_CANDIDATE, (signal: RtcSignal) => {
    io.to(signal.toId).emit(SocketEvents.RTC_ICE_CANDIDATE, signal);
  });
}
