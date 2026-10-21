const MapGenerator = require('../shared/MapGenerator');
const CONSTANTS = require('../shared/constants');
const { buildWalkGrid, createCobbs } = require('./cobb');

// Modes players can pick; add 'versus' and 'race' here once they are built
const MODES = ['coop'];

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return this.rooms.has(code) ? this.generateRoomCode() : code;
  }

  generateMap() {
    return new MapGenerator(Date.now()).generate(CONSTANTS.MAP.DEFAULT_WIDTH, CONSTANTS.MAP.DEFAULT_HEIGHT);
  }

  createRoom(hostSocketId, options = {}) {
    const roomCode = this.generateRoomCode();
    const mapData = this.generateMap();

    const room = {
      code: roomCode,
      hostId: hostSocketId,
      state: 'LOBBY', // LOBBY, PLAYING
      mode: MODES.includes(options.mode) ? options.mode : 'coop',
      level: 1,
      activeRules: [CONSTANTS.RULES.COBB_MOVE],
      mapData,
      // One player per spawn point until maps scale with player count
      maxPlayers: mapData.playerSpawns.length,
      players: new Map(),
      stats: {
        startTime: Date.now()
      }
    };

    this.rooms.set(roomCode, room);
    return room;
  }

  getRoom(roomCode) {
    return typeof roomCode === 'string' ? this.rooms.get(roomCode.toUpperCase()) : undefined;
  }

  addPlayer(roomCode, socketId, playerData = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return null;

    const playerIndex = room.players.size;
    const player = {
      id: socketId,
      name: playerData.name || `Survivor ${playerIndex + 1}`,
      color: this.nextColor(room),
      isHost: room.hostId === socketId,
      ready: false,
      role: 'SURVIVOR', // SURVIVOR, COBB (for versus)
      x: 0,
      y: 0,
      flipX: false
    };
    this.resetRoundState(player);
    this.placeAtSpawn(room, player, playerIndex);

    room.players.set(socketId, player);
    return player;
  }

  placeAtSpawn(room, player, index) {
    const spawn = room.mapData.playerSpawns[index % room.mapData.playerSpawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
  }

  resetRoundState(p) {
    p.role = 'SURVIVOR';
    p.lastMoveAt = 0;
    p.isSprinting = false;
    p.hasCoal = false;
    p.coalId = null;
    p.isEscaped = false;
    p.isDowned = false;
    p.isDead = false;
    p.bleedLeft = 0;       // ms until a downed player dies
    p.reviveProgress = 0;  // ms a teammate has spent reviving them
    p.reviving = false;    // holding E over a downed teammate
    p.safeUntil = 0;       // Cobb can't grab before this time
  }

  // Fresh map, Cobb and player state for a new round
  startRound(room) {
    const now = Date.now();
    room.mapData = this.generateMap();
    room.walk = buildWalkGrid(room.mapData);
    room.cobbs = createCobbs(room.mapData, now);
    room.state = 'PLAYING';
    room.stats.startTime = now;

    let index = 0;
    room.players.forEach((p) => {
      this.resetRoundState(p);
      this.placeAtSpawn(room, p, index++);
    });
  }

  // Players stay ready between rounds so the host can retry straight away
  endRound(room, won) {
    room.state = 'LOBBY';
    if (won) room.level += 1;
  }

  removePlayer(socketId) {
    for (const [code, room] of this.rooms.entries()) {
      if (room.players.has(socketId)) {
        room.players.delete(socketId);
        if (room.players.size === 0) {
          this.rooms.delete(code);
        } else if (room.hostId === socketId) {
          // Pass host to next player
          const nextHost = room.players.keys().next().value;
          room.hostId = nextHost;
          room.players.get(nextHost).isHost = true;
        }
        return { code, room };
      }
    }
    return null;
  }

  // First colour nobody in the room is using
  nextColor(room) {
    const used = new Set(Array.from(room.players.values(), p => p.color));
    const colors = [
      0x4aa8ff, // Cyan / Blue
      0xffa338, // Amber / Orange
      0x5cf088, // Emerald Green
      0xff63b1, // Rose Pink
      0xba68c8, // Purple
      0xffe066, // Yellow
      0x4dd0e1, // Teal
      0xff5252  // Coral Red
    ];
    return colors.find(c => !used.has(c)) || colors[0];
  }
}

RoomManager.MODES = MODES;
module.exports = RoomManager;
