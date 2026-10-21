const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./RoomManager');
const CONSTANTS = require('../shared/constants');
const { isActive } = require('./cobb');
const { tickRoom, snapshot, roundResult, dropCoal } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const roomManager = new RoomManager();

// Server-side reach is a bit more generous than the client's to absorb latency
const REACH_SLACK = 40;
const CHAT_MAX_LENGTH = 100;
const CHAT_MIN_INTERVAL = 400;
const MOVE_MIN_INTERVAL = 30;
const TICK_MS = 50; // 20 world updates a second

// Serve static client files
app.use(express.static(path.join(__dirname, '../client')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: roomManager.rooms.size });
});

const isObject = (v) => v !== null && typeof v === 'object';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const near = (p, target, radius) => Math.hypot(p.x - target.x, p.y - target.y) <= radius;

// Socket.IO real-time multiplayer connections
io.on('connection', (socket) => {
  console.log(`[Socket] Player connected: ${socket.id}`);

  // Every handler gets an object payload and a callable ack, and can never crash the process
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      try {
        handler(isObject(payload) ? payload : {}, typeof ack === 'function' ? ack : () => {});
      } catch (err) {
        console.error(`[Socket] ${event} from ${socket.id} failed:`, err);
      }
    });
  };

  const fail = (ack, message) => {
    const err = { success: false, message };
    ack(err);
    socket.emit('room:error', err);
  };

  // Room and player for this socket, optionally only while a round is running
  const current = (playingOnly) => {
    const room = roomManager.getRoom(socket.roomCode);
    const player = room && room.players.get(socket.id);
    if (!player || (playingOnly && room.state !== 'PLAYING')) return {};
    return { room, player };
  };

  const enterRoom = (room, playerData, ack) => {
    const player = roomManager.addPlayer(room.code, socket.id, {
      name: cleanText(isObject(playerData) ? playerData.name : '', 14)
    });
    socket.join(room.code);
    socket.roomCode = room.code;

    const response = { success: true, roomCode: room.code, player, room: serializeRoom(room) };
    ack(response);
    socket.emit('room:joined', response);
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  };

  // Create Room
  on('room:create', ({ mode, playerData }, ack) => {
    if (socket.roomCode) return fail(ack, 'Already in a room.');
    const room = roomManager.createRoom(socket.id, { mode });
    enterRoom(room, playerData, ack);
  });

  // Join Room
  on('room:join', ({ roomCode, playerData }, ack) => {
    if (socket.roomCode) return fail(ack, 'Already in a room.');
    const room = roomManager.getRoom(roomCode);
    if (!room) return fail(ack, 'Room not found! Check room code.');
    if (room.state !== 'LOBBY') return fail(ack, 'Game already in progress!');
    if (room.players.size >= room.maxPlayers) return fail(ack, `Room is full (${room.maxPlayers} max).`);
    enterRoom(room, playerData, ack);
  });

  // Lobby settings (Host only)
  on('room:settings', ({ mode }) => {
    const { room } = current(false);
    if (!room || room.hostId !== socket.id || room.state !== 'LOBBY') return;
    if (!RoomManager.MODES.includes(mode)) return;
    room.mode = mode;
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  });

  // Toggle Ready
  on('room:ready', ({ ready }) => {
    const { room, player } = current(false);
    if (!room || room.state !== 'LOBBY' || player.ready === (ready === true)) return;
    player.ready = ready === true;
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  });

  // Start Game (Host only, everyone else ready)
  on('game:start', (payload, ack) => {
    const { room } = current(false);
    if (!room || room.hostId !== socket.id || room.state !== 'LOBBY') return;
    const waiting = Array.from(room.players.values()).filter(p => !p.isHost && !p.ready);
    if (waiting.length) {
      return fail(ack, `Waiting for ${waiting.map(p => p.name).join(', ')} to ready up.`);
    }

    roomManager.startRound(room);

    // Assign roles in versus mode if selected
    if (room.mode === 'versus') {
      const playerIds = Array.from(room.players.keys());
      const cobbId = playerIds[Math.floor(Math.random() * playerIds.length)];
      room.players.get(cobbId).role = 'COBB';
    }

    ack({ success: true });
    io.to(room.code).emit('game:started', { room: serializeRoom(room, true) });
  });

  // Full round state for a client whose scene just booted (it may have missed events while loading)
  on('game:sync', (payload, ack) => {
    const { room } = current(true);
    if (room) ack({ room: serializeRoom(room, true) });
  });

  // Player Movement Sync (client owns its position, server caps the speed)
  on('player:move', ({ x, y, flipX, isSprinting }) => {
    const { room, player } = current(true);
    if (!room || !isActive(player) || !isNum(x) || !isNum(y)) return;

    const ts = CONSTANTS.TILE_SIZE;
    const now = Date.now();
    // Client sends every 50 ms; anything much faster is flooding
    if (now - player.lastMoveAt < MOVE_MIN_INTERVAL) return;
    const dt = player.lastMoveAt ? Math.min(now - player.lastMoveAt, 1000) : 1000;
    // Slack covers network jitter
    const maxStep = CONSTANTS.PLAYER.SPRINT_SPEED * (dt / 1000) * 1.5 + 40;
    const inBounds = x >= 0 && y >= 0 && x <= room.mapData.width * ts && y <= room.mapData.height * ts;

    if (!inBounds || Math.hypot(x - player.x, y - player.y) > maxStep) {
      socket.emit('player:correct', { x: player.x, y: player.y });
      return;
    }

    player.x = x;
    player.y = y;
    player.flipX = flipX === true;
    player.isSprinting = isSprinting === true;
    player.lastMoveAt = now;

    socket.to(room.code).emit('player:moved', {
      id: socket.id,
      x,
      y,
      flipX: player.flipX,
      isSprinting: player.isSprinting
    });
  });

  // Coal Picked Up
  on('coal:pickup', ({ coalId }) => {
    const { room, player } = current(true);
    if (!room || player.hasCoal || !isActive(player)) return;
    const coal = room.mapData.coal.find(c => c.id === coalId);
    if (!coal || coal.collected) return;
    if (!near(player, coal, CONSTANTS.PLAYER.INTERACTION_RADIUS + REACH_SLACK)) return;

    coal.collected = true;
    player.hasCoal = true;
    player.coalId = coal.id;
    io.to(room.code).emit('coal:updated', { coalId, collectedBy: socket.id });
  });

  // Coal Deposited in Furnace
  on('furnace:deposit', () => {
    const { room, player } = current(true);
    if (!room || !player.hasCoal || !isActive(player)) return;
    const furnace = room.mapData.furnace;
    if (!near(player, furnace, CONSTANTS.PLAYER.INTERACTION_RADIUS + 25 + REACH_SLACK)) return;

    player.hasCoal = false;
    player.coalId = null;
    furnace.coalDeposited += 1;
    if (furnace.coalDeposited >= furnace.coalRequired) {
      room.mapData.exit.unlocked = true;
    }

    io.to(room.code).emit('furnace:updated', {
      depositedBy: socket.id,
      coalDeposited: furnace.coalDeposited,
      coalRequired: furnace.coalRequired,
      exitUnlocked: room.mapData.exit.unlocked
    });
  });

  // Breaker Switch Flipped
  on('breaker:toggle', ({ breakerId }) => {
    const { room, player } = current(true);
    if (!room || !isActive(player)) return;
    const breaker = room.mapData.breakers.find(b => b.id === breakerId);
    if (!breaker || !near(player, breaker, CONSTANTS.PLAYER.INTERACTION_RADIUS + REACH_SLACK)) return;

    breaker.active = !breaker.active;
    io.to(room.code).emit('breaker:updated', { breakerId, active: breaker.active, triggeredBy: socket.id });
  });

  // Player Escape
  on('player:escape', () => {
    const { room, player } = current(true);
    if (!room || !isActive(player) || !room.mapData.exit.unlocked) return;
    if (!near(player, room.mapData.exit, CONSTANTS.PLAYER.INTERACTION_RADIUS + 15 + REACH_SLACK)) return;

    player.isEscaped = true;
    io.to(room.code).emit('player:escaped', { id: socket.id, name: player.name });
    checkRoundOver(room);
  });

  // Holding E over a downed teammate; the tick loop checks distance and does the reviving
  on('player:reviving', ({ active }) => {
    const { player } = current(true);
    if (player) player.reviving = active === true && isActive(player);
  });

  // Chat message
  on('chat:send', ({ message }) => {
    const { room, player } = current(false);
    const text = cleanText(message, CHAT_MAX_LENGTH);
    const now = Date.now();
    if (!room || !text || now - (socket.lastChatAt || 0) < CHAT_MIN_INTERVAL) return;
    socket.lastChatAt = now;

    io.to(room.code).emit('chat:received', {
      sender: player.name,
      senderId: socket.id,
      message: text,
      time: new Date().toLocaleTimeString()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Player disconnected: ${socket.id}`);
    const { room, player } = current(true);
    const drop = room && dropCoal(room, player);
    if (drop) io.to(room.code).emit(...drop);

    const result = roomManager.removePlayer(socket.id);
    if (result && result.room.players.size > 0) {
      io.to(result.code).emit('player:left', { id: socket.id });
      checkRoundOver(result.room);
      io.to(result.code).emit('room:updated', { room: serializeRoom(result.room) });
    }
  });
});

function checkRoundOver(room) {
  if (room.state !== 'PLAYING') return;
  const results = roundResult(room);
  if (!results) return;
  roomManager.endRound(room, results.won);
  io.to(room.code).emit('game:round_over', { results, room: serializeRoom(room) });
}

// World simulation: Cobb, revives and bleed-outs for every running round
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(now - lastTick, 200); // don't let a stalled tick teleport Cobb
  lastTick = now;
  roomManager.rooms.forEach((room) => {
    if (room.state !== 'PLAYING') return;
    try {
      tickRoom(room, dt, now).forEach(([event, data]) => io.to(room.code).emit(event, data));
      io.to(room.code).emit('world:tick', snapshot(room));
      checkRoundOver(room);
    } catch (err) {
      console.error(`[Tick] Room ${room.code} failed:`, err);
    }
  });
}, TICK_MS);

// The map is only needed in-game, so lobby updates leave it out
function serializeRoom(room, withMap = false) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    mode: room.mode,
    level: room.level,
    maxPlayers: room.maxPlayers,
    activeRules: room.activeRules,
    mapData: withMap ? room.mapData : undefined,
    cobbs: withMap ? snapshot(room).cobbs : undefined,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      ready: p.ready,
      role: p.role,
      x: p.x,
      y: p.y,
      flipX: p.flipX,
      isSprinting: p.isSprinting,
      hasCoal: p.hasCoal,
      isDowned: p.isDowned,
      isDead: p.isDead,
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
