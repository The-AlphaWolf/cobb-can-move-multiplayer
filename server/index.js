const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./RoomManager');
const CONSTANTS = require('../shared/constants');
const { isActive, inSafeZone, LIT, toTile } = require('./cobb');
const { tickRoom, snapshot, roundResult, dropCoal, makeNoise, recordTrail, throwRock } = require('./game');

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
const BREAKER_COOLDOWN = 500;
const THROW_COOLDOWN = 600;
const SPRINT_NOISE_INTERVAL = 400;

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

  const fail = (ack, message) => ack({ success: false, message });

  // Room and player for this socket, optionally only while a round is running
  const current = (playingOnly) => {
    const room = roomManager.getRoom(socket.roomCode);
    const player = room && room.players.get(socket.id);
    if (!player || (playingOnly && room.state !== 'PLAYING')) return {};
    return { room, player };
  };

  // playerId is a secret the browser keeps so it can reclaim its seat after a dropped connection
  const enterRoom = (room, playerData, playerId, ack) => {
    const player = roomManager.addPlayer(room.code, socket.id, {
      name: cleanText(isObject(playerData) ? playerData.name : '', 14)
    });
    player.playerId = cleanText(playerId, 64) || null;
    socket.join(room.code);
    socket.roomCode = room.code;

    const response = { success: true, roomCode: room.code, room: serializeRoom(room) };
    ack(response);
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
  };

  // Create Room
  on('room:create', ({ mode, playerData, playerId }, ack) => {
    if (socket.roomCode) return fail(ack, 'Already in a room.');
    const room = roomManager.createRoom(socket.id, { mode });
    enterRoom(room, playerData, playerId, ack);
  });

  // Join Room
  on('room:join', ({ roomCode, playerData, playerId }, ack) => {
    if (socket.roomCode) return fail(ack, 'Already in a room.');
    const room = roomManager.getRoom(roomCode);
    if (!room) return fail(ack, 'Room not found! Check room code.');
    if (room.state !== 'LOBBY') return fail(ack, 'Game already in progress!');
    if (room.players.size >= room.maxPlayers) return fail(ack, `Room is full (${room.maxPlayers} max).`);
    enterRoom(room, playerData, playerId, ack);
  });

  // Reclaim a held seat after a dropped connection, even mid-round
  on('room:rejoin', ({ roomCode, playerId }, ack) => {
    if (socket.roomCode) return fail(ack, 'Already in a room.');
    const room = roomManager.getRoom(roomCode);
    const id = cleanText(playerId, 64);
    const player = room && id && Array.from(room.players.values()).find(p => p.away && p.playerId === id);
    if (!player) return fail(ack, 'Your seat is gone. Join the room again.');

    clearTimeout(player.holdTimer);
    const oldId = player.id;
    room.players.delete(oldId);
    player.id = socket.id;
    player.away = false;
    room.players.set(socket.id, player);
    if (room.hostId === oldId) room.hostId = socket.id;
    (room.cobbs || []).forEach((c) => {
      if (c.heldFor === oldId) c.controlledBy = socket.id;
      if (c.targetId === oldId) c.targetId = socket.id;
      if (c.mimicId === oldId) c.mimicId = socket.id;
      if (c.heldFor === oldId) c.heldFor = null;
    });
    socket.join(room.code);
    socket.roomCode = room.code;

    ack({ success: true, room: serializeRoom(room, room.state === 'PLAYING') });
    socket.to(room.code).emit('player:rejoined', { oldId, newId: socket.id });
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
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
    // Dropped players don't hold up the start; they rejoin straight into the round
    const waiting = Array.from(room.players.values()).filter(p => !p.isHost && !p.ready && !p.away);
    if (waiting.length) {
      return fail(ack, `Waiting for ${waiting.map(p => p.name).join(', ')} to ready up.`);
    }
    if (room.mode !== 'coop' && room.players.size < CONSTANTS.VERSUS.MIN_PLAYERS) {
      return fail(ack, `${room.mode === 'versus' ? 'Versus' : 'Race'} needs at least ${CONSTANTS.VERSUS.MIN_PLAYERS} players.`);
    }

    roomManager.startRound(room);
    ack({ success: true });
    io.to(room.code).emit('game:started', { room: serializeRoom(room, true) });
  });

  // Full round state for a client whose scene just booted (it may have missed events while loading)
  on('game:sync', (payload, ack) => {
    const { room } = current(true);
    if (room) ack({ room: serializeRoom(room, true) });
  });

  // Player Movement Sync (client owns its position, server caps the speed)
  on('player:move', ({ x, y, flipX, isSprinting, lanternDim }) => {
    const { room, player } = current(true);
    if (!room || !isNum(x) || !isNum(y)) return;
    const now = Date.now();
    if (now - player.lastMoveAt < MOVE_MIN_INTERVAL) return;
    if (player.role === 'COBB') return moveCobb(room, player, x, y, flipX === true, now);
    if (!isActive(player)) return;

    const ts = CONSTANTS.TILE_SIZE;
    // Stunned by a rival's rock: hold still
    if (now < player.stunnedUntil) {
      socket.emit('player:correct', { x: player.x, y: player.y });
      return;
    }
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
    player.lanternDim = lanternDim === true;
    player.lastMoveAt = now;
    recordTrail(player, now);
    // Footsteps carry when you run
    if (player.isSprinting && now - (player.noiseAt || 0) >= SPRINT_NOISE_INTERVAL) {
      player.noiseAt = now;
      emitEvent(room, makeNoise(room, x, y, CONSTANTS.NOISE.SPRINT, now));
    }

    socket.to(room.code).emit('player:moved', {
      id: socket.id,
      x,
      y,
      flipX: player.flipX,
      isSprinting: player.isSprinting,
      lanternDim: player.lanternDim
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
    player.coalSince = Date.now();
    io.to(room.code).emit('coal:updated', { coalId, collectedBy: socket.id });
    emitEvent(room, makeNoise(room, coal.x, coal.y, CONSTANTS.NOISE.COAL));
  });

  // Coal Deposited in Furnace
  on('furnace:deposit', () => {
    const { room, player } = current(true);
    if (!room || !player.hasCoal || !isActive(player)) return;
    const furnace = room.mapData.furnace;
    if (!near(player, furnace, CONSTANTS.PLAYER.INTERACTION_RADIUS + 25 + REACH_SLACK)) return;

    player.hasCoal = false;
    player.coalId = null;
    player.deposited += 1;
    furnace.coalDeposited += 1;
    furnace.fuel = Math.min(CONSTANTS.FURNACE.MAX_FUEL, furnace.fuel + CONSTANTS.FURNACE.FUEL_PER_COAL);
    // In a race the exit only opens for each player's own quota (see player:escape)
    if (room.mode !== 'race' && furnace.coalDeposited >= furnace.coalRequired) {
      room.mapData.exit.unlocked = true;
    }

    io.to(room.code).emit('furnace:updated', {
      depositedBy: socket.id,
      playerDeposited: player.deposited,
      coalDeposited: furnace.coalDeposited,
      coalRequired: furnace.coalRequired,
      fuel: furnace.fuel,
      exitUnlocked: room.mapData.exit.unlocked
    });
    emitEvent(room, makeNoise(room, furnace.x, furnace.y, CONSTANTS.NOISE.DEPOSIT));
  });

  // Breaker Switch Flipped
  on('breaker:toggle', ({ breakerId }) => {
    const { room, player } = current(true);
    if (!room || !isActive(player)) return;
    const breaker = room.mapData.breakers.find(b => b.id === breakerId);
    if (!breaker || !near(player, breaker, CONSTANTS.PLAYER.INTERACTION_RADIUS + REACH_SLACK)) return;
    // A heavy switch: no strobing the lights or flooding the room with toggles
    const now = Date.now();
    if (now - (breaker.toggledAt || 0) < BREAKER_COOLDOWN) return;
    breaker.toggledAt = now;

    breaker.active = !breaker.active;
    io.to(room.code).emit('breaker:updated', { breakerId, active: breaker.active, triggeredBy: socket.id });
    emitEvent(room, makeNoise(room, breaker.x, breaker.y, CONSTANTS.NOISE.BREAKER, now));
  });

  // Rocks: pick up (carry a few), throw at a point to make noise or stun Cobb
  on('rock:pickup', ({ rockId }) => {
    const { room, player } = current(true);
    if (!room || !isActive(player) || player.rocks >= CONSTANTS.PLAYER.ROCK_MAX) return;
    const rocks = room.mapData.rocks;
    const i = rocks.findIndex(r => r.id === rockId);
    if (i < 0 || !near(player, rocks[i], CONSTANTS.PLAYER.INTERACTION_RADIUS + REACH_SLACK)) return;
    rocks.splice(i, 1);
    player.rocks += 1;
    io.to(room.code).emit('rock:taken', { rockId, by: socket.id, rocks: player.rocks });
  });

  on('rock:throw', ({ x, y }) => {
    const { room, player } = current(true);
    const now = Date.now();
    if (!room || !isActive(player) || player.rocks <= 0 || !isNum(x) || !isNum(y)) return;
    if (now - (player.thrownAt || 0) < THROW_COOLDOWN) return;
    player.thrownAt = now;
    throwRock(room, player, { x, y }, now).forEach(e => emitEvent(room, e));
  });

  // STARVE: eat a carrot; it grows back after a while
  on('carrot:eat', ({ carrotId }) => {
    const { room, player } = current(true);
    if (!room || !isActive(player) || !room.cfg.starve) return;
    const carrot = room.mapData.carrots.find(c => c.id === carrotId);
    if (!carrot || carrot.respawnAt || !near(player, carrot, CONSTANTS.PLAYER.INTERACTION_RADIUS + REACH_SLACK)) return;
    carrot.respawnAt = Date.now() + CONSTANTS.PLAYER.CARROT_RESPAWN;
    player.hunger = Math.min(CONSTANTS.PLAYER.HUNGER_MAX, player.hunger + CONSTANTS.PLAYER.CARROT_FOOD);
    io.to(room.code).emit('carrot:updated', { carrotId, available: false, eatenBy: socket.id });
  });

  // Player Escape
  on('player:escape', () => {
    const { room, player } = current(true);
    if (!room || !isActive(player)) return;
    const open = room.mode === 'race' ? player.deposited >= CONSTANTS.RACE.QUOTA : room.mapData.exit.unlocked;
    if (!open || !near(player, room.mapData.exit, CONSTANTS.PLAYER.INTERACTION_RADIUS + 15 + REACH_SLACK)) return;

    player.isEscaped = true;
    if (room.mode === 'race' && !room.raceWinner) room.raceWinner = socket.id;
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

  // Disconnect: hold the seat for a while so a dropped connection can come back
  socket.on('disconnect', () => {
    console.log(`[Socket] Player disconnected: ${socket.id}`);
    const { room, player } = current(false);
    if (!room) return;
    const drop = room.state === 'PLAYING' && dropCoal(room, player);
    if (drop) io.to(room.code).emit(...drop);

    player.away = true;
    player.reviving = false;
    // A Versus Cobb left without its player goes back to the AI until they return
    (room.cobbs || []).forEach((c) => {
      if (c.controlledBy === player.id) {
        c.controlledBy = null;
        c.heldFor = player.id;
      }
    });
    if (room.hostId === player.id) roomManager.passHost(room);
    if (Array.from(room.players.values()).every(p => p.away)) {
      roomManager.rooms.delete(room.code); // nobody left to come back to
      return;
    }
    io.to(room.code).emit('player:away', { id: player.id });
    io.to(room.code).emit('room:updated', { room: serializeRoom(room) });
    checkRoundOver(room);

    player.holdTimer = setTimeout(() => {
      if (!player.away) return;
      const result = roomManager.removePlayer(player.id);
      if (result && result.room.players.size > 0) {
        io.to(result.code).emit('player:left', { id: player.id });
        checkRoundOver(result.room);
        io.to(result.code).emit('room:updated', { room: serializeRoom(result.room) });
      }
    }, CONSTANTS.RECONNECT_HOLD);
  });

  // VERSUS: the Cobb player steers Cobb. Same speed cap idea as survivors, plus walls,
  // the fire's safe zone, start delay, stuns and (CAN'T MOVE) being watched.
  function moveCobb(room, player, x, y, flipX, now) {
    const cobb = room.cobbs.find(c => c.controlledBy === player.id);
    if (!cobb) return;
    const C = CONSTANTS.COBB;
    const dt = player.lastMoveAt ? Math.min(now - player.lastMoveAt, 1000) : 1000;
    const speed = CONSTANTS.VERSUS.COBB_SPEED * room.cfg.speedMul * (room.cfg.cantMove ? C.UNWATCHED_MUL : 1);
    const maxStep = speed * (dt / 1000) * 1.5 + 40;
    const row = room.mapData.grid[toTile(y)];
    const onFloor = row && row[toTile(x)] === CONSTANTS.TILE_TYPES.FLOOR;
    const into = room.walk[toTile(y)] && room.walk[toTile(y)][toTile(x)];
    const enteringFire = into === LIT && !inSafeZone(room, cobb);
    const held = now < cobb.pauseUntil || cobb.frozen;
    player.lastMoveAt = now;
    if (held || !onFloor || enteringFire || Math.hypot(x - cobb.x, y - cobb.y) > maxStep) {
      socket.emit('player:correct', { x: cobb.x, y: cobb.y });
      return;
    }
    cobb.x = x;
    cobb.y = y;
    cobb.flipX = flipX;
    player.x = x;
    player.y = y;
  }
});

// Send one [event, data] pair (from game.js) to everyone in the room
function emitEvent(room, e) {
  if (e) io.to(room.code).emit(e[0], e[1]);
}

// VERSUS + SMELL: the Cobb player sees fresh scent trails, a few times a second
function sendScent(room, now) {
  if (room.mode !== 'versus' || !room.cfg.smell || now - (room.scentAt || 0) < 500) return;
  room.scentAt = now;
  const crumbs = [];
  room.players.forEach((p) => {
    if (isActive(p)) p.trail.forEach(c => crumbs.push({ x: Math.round(c.x), y: Math.round(c.y), age: now - c.t }));
  });
  room.cobbs.forEach((c) => {
    if (c.controlledBy) io.to(c.controlledBy).emit('cobb:scent', { crumbs });
  });
}

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
      sendScent(room, now);
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
    cfg: room.cfg,
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
      isEscaped: p.isEscaped,
      away: !!p.away,
      deposited: p.deposited,
      lanternDim: p.lanternDim,
      rocks: p.rocks,
      warmth: p.warmth,
      hunger: p.hunger
    }))
  };
}

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🎮 COBB CAN MOVE - Multiplayer Server running!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
