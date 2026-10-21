const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./RoomManager');
const CONSTANTS = require('./constants');
const MapGenerator = require('./MapGenerator');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const roomManager = new RoomManager();

// Serve static client files
app.use(express.static(path.join(__dirname, '../client')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: roomManager.rooms.size });
});

// Socket.IO real-time multiplayer connections
io.on('connection', (socket) => {
  console.log(`[Socket] Player connected: ${socket.id}`);

  // Create Room
  socket.on('room:create', (options, callback) => {
    const room = roomManager.createRoom(socket.id, options);
    const player = roomManager.addPlayer(room.code, socket.id, options.playerData || {});
    socket.join(room.code);
    socket.roomCode = room.code;

    const response = {
      success: true,
      roomCode: room.code,
      player,
      room: serializeRoom(room)
    };
    if (typeof callback === 'function') callback(response);
    socket.emit('room:joined', response);
  });

  // Join Room
  socket.on('room:join', ({ roomCode, playerData }, callback) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) {
      const err = { success: false, message: 'Room not found! Check room code.' };
      if (typeof callback === 'function') callback(err);
      socket.emit('room:error', err);
      return;
    }
    if (room.state !== 'LOBBY') {
      const err = { success: false, message: 'Game already in progress!' };
      if (typeof callback === 'function') callback(err);
      socket.emit('room:error', err);
      return;
    }

    const player = roomManager.addPlayer(room.code, socket.id, playerData || {});
    socket.join(room.code);
    socket.roomCode = room.code;

    const response = {
      success: true,
      roomCode: room.code,
      player,
      room: serializeRoom(room)
    };
    if (typeof callback === 'function') callback(response);
    socket.emit('room:joined', response);

    // Notify room of new player
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  });

  // Toggle Ready
  socket.on('room:ready', ({ ready }) => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room || !room.players.has(socket.id)) return;
    const player = room.players.get(socket.id);
    player.ready = ready;
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  });

  // Start Game (Host only)
  socket.on('game:start', () => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.state = 'PLAYING';
    room.stats.startTime = Date.now();

    // Assign roles in versus mode if selected
    if (room.mode === 'versus') {
      const playerIds = Array.from(room.players.keys());
      const cobbId = playerIds[Math.floor(Math.random() * playerIds.length)];
      room.players.forEach((p, id) => {
        p.role = id === cobbId ? 'COBB' : 'SURVIVOR';
      });
    }

    io.to(room.code).emit('game:started', { room: serializeRoom(room) });
  });

  // Player Movement & Input Sync
  socket.on('player:move', (data) => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    player.x = data.x;
    player.y = data.y;
    player.vx = data.vx || 0;
    player.vy = data.vy || 0;
    player.isSprinting = data.isSprinting || false;
    player.hasCoal = data.hasCoal || false;

    // Relay delta movement to other players in room
    socket.to(room.code).emit('player:moved', {
      id: socket.id,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      isSprinting: player.isSprinting,
      hasCoal: player.hasCoal
    });
  });

  // Coal Picked Up
  socket.on('coal:pickup', ({ coalId }) => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room) return;
    const coal = room.mapData.coal.find(c => c.id === coalId);
    if (coal && !coal.collected) {
      coal.collected = true;
      const player = room.players.get(socket.id);
      if (player) player.hasCoal = true;

      io.to(room.code).emit('coal:updated', {
        coalId,
        collectedBy: socket.id
      });
    }
  });

  // Coal Deposited in Furnace
  socket.on('furnace:deposit', () => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player && player.hasCoal) {
      player.hasCoal = false;
      room.mapData.furnace.coalDeposited += 1;

      const isUnlocked = room.mapData.furnace.coalDeposited >= room.mapData.furnace.coalRequired;
      if (isUnlocked) {
        room.mapData.exit.unlocked = true;
      }

      io.to(room.code).emit('furnace:updated', {
        depositedBy: socket.id,
        coalDeposited: room.mapData.furnace.coalDeposited,
        coalRequired: room.mapData.furnace.coalRequired,
        exitUnlocked: room.mapData.exit.unlocked
      });
    }
  });

  // Breaker Switch Flipped
  socket.on('breaker:toggle', ({ breakerId }) => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room) return;
    const breaker = room.mapData.breakers.find(b => b.id === breakerId);
    if (breaker) {
      breaker.active = !breaker.active;
      io.to(room.code).emit('breaker:updated', {
        breakerId,
        active: breaker.active,
        triggeredBy: socket.id
      });
    }
  });

  // Player Escape
  socket.on('player:escape', () => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player && !player.isEscaped) {
      player.isEscaped = true;
      io.to(room.code).emit('player:escaped', { id: socket.id, name: player.name });

      // Check if all active survivors escaped
      const survivors = Array.from(room.players.values()).filter(p => p.role === 'SURVIVOR');
      const allDone = survivors.every(p => p.isEscaped || p.isDowned);
      if (allDone) {
        io.to(room.code).emit('game:round_over', {
          won: survivors.some(p => p.isEscaped),
          room: serializeRoom(room)
        });
      }
    }
  });

  // Chat message
  socket.on('chat:send', ({ message }) => {
    const room = roomManager.getRoom(socket.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    const name = player ? player.name : 'Unknown';
    io.to(room.code).emit('chat:received', {
      sender: name,
      senderId: socket.id,
      message,
      time: new Date().toLocaleTimeString()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Player disconnected: ${socket.id}`);
    const result = roomManager.removePlayer(socket.id);
    if (result && result.room) {
      io.to(result.code).emit('room:updated', { room: serializeRoom(result.room) });
      io.to(result.code).emit('player:left', { id: socket.id });
    }
  });
});

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    mode: room.mode,
    level: room.level,
    activeRules: room.activeRules,
    mapData: room.mapData,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      ready: p.ready,
      role: p.role,
      x: p.x,
      y: p.y,
      isSprinting: p.isSprinting,
      hasCoal: p.hasCoal,
      isDowned: p.isDowned,
      isEscaped: p.isEscaped
    }))
  };
}

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🎮 COBB CAN MOVE - Multiplayer Server running!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
