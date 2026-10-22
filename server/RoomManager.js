const MapGenerator = require('../shared/MapGenerator');
const CONSTANTS = require('../shared/constants');
const { rollRules, ruleConfig } = require('../shared/rules');
const { buildWalkGrid, createCobbs } = require('./cobb');

const MODES = ['coop', 'versus', 'race'];

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

  // Level 1 is the fixed intro facility; later levels get a fresh layout, a size bigger for
  // 3-4 players and a size bigger again for each extra Cobb hunting (DUPLICATE)
  generateMap(level = 1, playerCount = 1, cobbCount = 1) {
    const gen = new MapGenerator((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
    if (level <= 1) return gen.classic();
    const tiers = CONSTANTS.MAP_TIERS;
    const size = tiers[Math.min(tiers.length - 1, (playerCount > 2 ? 1 : 0) + (cobbCount - 1))];
    const fireZone = CONSTANTS.LIGHTS.FURNACE_RADIUS * CONSTANTS.FURNACE.SAFE_SHARE; // the zone at its largest
    try {
      return gen.generate(size.width, size.height, { coalCount: size.coal, fireZone });
    } catch (err) {
      // Never seen in 600 test seeds, but a round must always start
      console.error(err.message);
      return gen.classic();
    }
  }

  createRoom(hostSocketId, options = {}) {
    const roomCode = this.generateRoomCode();
    const mapData = this.generateMap();

    const room = {
      code: roomCode,
      hostId: hostSocketId,
      state: 'LOBBY', // LOBBY, PLAYING
      mode: MODES.includes(options.mode) ? options.mode : 'coop',
      // COBB_START_LEVEL lets you playtest later levels without clearing the earlier ones
      level: Math.max(1, parseInt(process.env.COBB_START_LEVEL, 10) || 1),
      activeRules: [],
      rulesLevel: 0, // a failed level is retried with the same rules
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
    p.warmth = CONSTANTS.PLAYER.WARMTH_MAX;
    p.hunger = CONSTANTS.PLAYER.HUNGER_MAX;
    p.rocks = 0;
    p.trail = [];          // scent breadcrumbs
    p.trailAt = 0;
    p.lanternDim = false;  // shuttered lantern
    p.coalSince = 0;       // when they picked up the coal they carry (HOT COAL)
    p.deposited = 0;       // coal this player fed the furnace (RACE)
    p.stunnedUntil = 0;    // hit by a rival's rock (RACE)
  }

  // Fresh map, Cobb and player state for a new round
  startRound(room) {
    const now = Date.now();
    const players = Array.from(room.players.values());
    if (room.rulesLevel !== room.level || room.rulesMode !== room.mode) {
      room.activeRules = rollRules(room.level, Math.random, { mode: room.mode, players: players.length });
      room.rulesLevel = room.level;
      room.rulesMode = room.mode;
    }
    room.cfg = ruleConfig(room.activeRules, room.level);
    room.mapData = this.generateMap(room.level, room.players.size, room.cfg.cobbCount);
    room.mapData.furnace.fuel = CONSTANTS.FURNACE.START_FUEL;
    // Bigger facility, longer coal runs: the fire burns slower in step with how far you walk
    // (trip length grows with the square root of the area; level 1's 46x36 burns at full speed)
    room.mapData.furnace.burnRate = Math.sqrt((46 * 36) / (room.mapData.width * room.mapData.height));
    room.safeRadius = CONSTANTS.safeRadius(room.mapData.furnace.fuel);
    room.walk = buildWalkGrid(room.mapData, room.safeRadius);
    room.cobbs = createCobbs(room.mapData, now, room.cfg.cobbCount);
    room.noises = [];
    room.nextRockId = 0;
    room.lastDownCause = null;
    room.raceWinner = null;
    room.state = 'PLAYING';
    room.stats.startTime = now;

    let index = 0;
    players.forEach((p) => {
      this.resetRoundState(p);
      this.placeAtSpawn(room, p, index++);
    });

    // VERSUS: the Cobb role rotates through the room, one round each
    if (room.mode === 'versus') {
      const present = players.filter(p => !p.away);
      room.cobbTurn = ((room.cobbTurn ?? -1) + 1) % present.length;
      const hunter = present[room.cobbTurn];
      hunter.role = 'COBB';
      room.cobbs[0].controlledBy = hunter.id;
      hunter.x = room.cobbs[0].x;
      hunter.y = room.cobbs[0].y;
    }

    // More survivors, more coal to find (up to what the map holds); race counts per player
    const survivors = players.filter(p => p.role === 'SURVIVOR').length;
    const f = room.mapData.furnace;
    f.coalRequired = room.mode === 'race'
      ? CONSTANTS.RACE.QUOTA
      : Math.min(room.mapData.coal.length, 3 + survivors);

    // MIMIC: each Cobb borrows a survivor's look
    if (room.cfg.mimic) {
      const faces = players.filter(p => p.role === 'SURVIVOR');
      room.cobbs.forEach((c, i) => { c.mimicId = faces[i % faces.length].id; });
    }
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
          this.passHost(room);
        }
        return { code, room };
      }
    }
    return null;
  }

  // Hand the host role to a connected player, if there is one
  passHost(room) {
    const next = Array.from(room.players.values()).find(p => !p.away && p.id !== room.hostId);
    if (!next) return;
    const old = room.players.get(room.hostId);
    if (old) old.isHost = false;
    room.hostId = next.id;
    next.isHost = true;
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
