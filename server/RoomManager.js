const MapGenerator = require('./MapGenerator');
const CONSTANTS = require('./constants');

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
      flipX: false,
      lastMoveAt: 0,
      isSprinting: false,
      hasCoal: false,
      isDowned: false,
      isEscaped: false
    };
    this.placeAtSpawn(room, player, playerIndex);

    room.players.set(socketId, player);
    return player;
  }

  placeAtSpawn(room, player, index) {
    const spawn = room.mapData.playerSpawns[index % room.mapData.playerSpawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
  }

  // Fresh map and player state for a new round
  startRound(room) {
    room.mapData = this.generateMap();
    room.state = 'PLAYING';
    room.stats.startTime = Date.now();

    let index = 0;
    room.players.forEach((p) => {
      this.placeAtSpawn(room, p, index++);
      p.hasCoal = false;
      p.isDowned = false;
      p.isEscaped = false;
      p.isSprinting = false;
      p.lastMoveAt = 0;
      p.role = 'SURVIVOR';
    });
  }

  endRound(room) {
    room.state = 'LOBBY';
    room.players.forEach((p) => { p.ready = false; });
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
