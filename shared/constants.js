// Shared constants for COBB CAN MOVE
const CONSTANTS = {
  TILE_SIZE: 32,
  MAP: {
    DEFAULT_WIDTH: 46,
    DEFAULT_HEIGHT: 36,
    MIN_ROOM_SIZE: 6,
    MAX_ROOM_SIZE: 16,
    MAX_ROOMS: 12,
    CORRIDOR_WIDTH: 3
  },
  TILE_TYPES: {
    EMPTY: 0,
    FLOOR: 1,
    WALL: 2,
    DOOR: 3,
    FURNACE: 4,
    EXIT: 5
  },
  PLAYER: {
    BASE_SPEED: 145,
    SPRINT_SPEED: 230,
    MAX_STAMINA: 100,
    STAMINA_DRAIN: 18,
    STAMINA_RECOVER: 35,
    INTERACTION_RADIUS: 55,
    WARMTH_MAX: 100,
    WARMTH_DRAIN: 4,
    HUNGER_MAX: 100,
    HUNGER_DRAIN: 3,
    REVIVE_RADIUS: 48,     // how close a teammate must stand to revive
    REVIVE_TIME: 2000,     // ms of holding E to pick someone up
    BLEEDOUT_TIME: 10000,  // ms a downed player waits before dying
    REVIVE_GRACE: 2000     // ms Cobb can't grab someone just revived
  },
  COBB: {
    WANDER_SPEED: 65,
    CHASE_SPEED: 105,
    AGGRO_RADIUS: 85,
    LOSE_RADIUS: 220,      // gives up the chase beyond this distance
    SEARCH_PAUSE: 2500,    // looks around this long where it lost you
    START_DELAY: 3000,     // head start at the beginning of a round
    REPATH_INTERVAL: 300,
    CHASE_DURATION: 3500,
    HIT_STUN: 2500,
    FAST_SPEED: 155,
    NORMAL_REACH: 30,
    LONG_REACH: 85,
    HEARING_RANGE: 280,
    VISION_RANGE: 220,
    SNIFF_INTERVAL: 4000
  },
  LIGHTS: {
    LANTERN_RADIUS: 140,
    LANTERN_STEALTH: 75,
    FURNACE_RADIUS: 240,
    BRAZIER_RADIUS: 130,
    AMBIENT_DARK: 0x050508
  },
  // Shown on the results screen after a failed level
  RULE_TIPS: {
    'COBB CAN MOVE': 'Cobb only notices you up close. Keep your distance, and walk away the moment it turns toward you.'
  },
  RULES: {
    // Canon
    COBB_MOVE: 'COBB CAN MOVE',
    COBB_SEE: 'COBB CAN SEE',
    COBB_HEAR: 'COBB CAN HEAR',
    COBB_SMELL: 'COBB CAN SMELL',
    COBB_REACH: 'COBB CAN REACH',
    COBB_DUPLICATE: 'COBB CAN DUPLICATE',
    COBB_FASTER: 'COBB CAN BE FASTER',
    COBB_CANT_MOVE: "COBB CAN'T MOVE",
    FREEZE: 'FREEZE',
    STARVE: 'STARVE',
    // Custom Multiplayer additions
    COBB_MIMIC: 'COBB CAN MIMIC',
    COBB_SHADOW_STEP: 'COBB CAN SHADOW STEP',
    COBB_EXTINGUISH: 'COBB CAN EXTINGUISH',
    COBB_HEAR_MIC: 'COBB CAN HEAR YOUR MIC',
    HOT_COAL: 'HOT COAL',
    TETHERED: 'TETHERED',
    MAZE_SHIFT: 'THE MAZE CAN SHIFT',
    LIGHT_BURNS: 'LIGHT CAN BURN',
    SHARED_HEARTBEAT: 'SHARED HEARTBEAT',
    BLIND_TRUST: 'BLIND TRUST'
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONSTANTS;
}
if (typeof window !== 'undefined') {
  window.CONSTANTS = CONSTANTS;
}
