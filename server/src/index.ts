import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
});

// Basic health endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Socket.IO connection handler
io.on(SocketEvents.CONNECT, (socket) => {
  console.log(`[server] player connected: ${socket.id}`);

  // Join the default room
  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    socket.join(roomId);
    console.log(`[server] ${socket.id} joined room ${roomId}`);

    // Notify other players
    socket.to(roomId).emit(SocketEvents.PLAYER_JOINED, {
      id: socket.id,
      name: `Player-${socket.id.slice(0, 4)}`,
      x: 160,
      y: 160,
      direction: 'down',
      color: '#4ecdc4',
      isMoving: false,
    });
  });

  // Relay movement to others in the same room
  socket.on(SocketEvents.PLAYER_MOVE, (data) => {
    socket.broadcast.emit(SocketEvents.PLAYER_MOVED, {
      id: socket.id,
      ...data,
    });
  });

  socket.on(SocketEvents.PLAYER_STOP, (data) => {
    socket.broadcast.emit(SocketEvents.PLAYER_STOPPED, {
      id: socket.id,
      ...data,
    });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    console.log(`[server] player disconnected: ${socket.id}`);
    io.emit(SocketEvents.PLAYER_LEFT, socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] VirtualMeet server running on http://localhost:${PORT}`);
});
