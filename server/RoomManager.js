const MapGenerator = require('./MapGenerator');
const CONSTANTS = require('./constants');

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

  createRoom(hostSocketId, options = {}) {
    const roomCode = this.generateRoomCode();
    const mapGen = new MapGenerator(Date.now());
    const mapData = mapGen.generate(CONSTANTS.MAP.DEFAULT_WIDTH, CONSTANTS.MAP.DEFAULT_HEIGHT, {
      playerCount: options.maxPlayers || 4
    });

    const room = {
      code: roomCode,
      hostId: hostSocketId,
      state: 'LOBBY', // LOBBY, PLAYING, ROUND_OVER, GAME_OVER
      mode: options.mode || 'coop', // coop, versus, race
      level: 1,
      activeRules: [CONSTANTS.RULES.COBB_MOVE],
      mapData,
      players: new Map(),
      cobb: {
        x: mapData.cobbSpawn.x,
        y: mapData.cobbSpawn.y,
        vx: 0,
        vy: 0,
        state: 'WANDER',
        targetPlayerId: null,
        stunnedUntil: 0
      },
      stats: {
        coalDeposited: 0,
        startTime: Date.now()
      }
    };

    this.rooms.set(roomCode, room);
    return room;
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode ? roomCode.toUpperCase() : '');
  }

  addPlayer(roomCode, socketId, playerData = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return null;

    const playerIndex = room.players.size;
    const spawn = room.mapData.playerSpawns[playerIndex % room.mapData.playerSpawns.length];

    const player = {
      id: socketId,
      name: playerData.name || `Survivor ${playerIndex + 1}`,
      color: playerData.color || this.getPlayerColor(playerIndex),
      isHost: room.hostId === socketId,
      ready: false,
      role: 'SURVIVOR', // SURVIVOR, COBB (for versus)
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      stamina: CONSTANTS.PLAYER.MAX_STAMINA,
      isSprinting: false,
      hasCoal: false,
      rocksCount: 0,
      warmth: CONSTANTS.PLAYER.WARMTH_MAX,
      hunger: CONSTANTS.PLAYER.HUNGER_MAX,
      isDowned: false,
      isEscaped: false
    };

    room.players.set(socketId, player);
    return player;
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

  getPlayerColor(index) {
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
    return colors[index % colors.length];
  }
}

module.exports = RoomManager;
