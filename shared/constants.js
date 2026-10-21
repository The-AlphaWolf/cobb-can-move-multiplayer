// Shared constants for COBB CAN MOVE (loaded by the server and the browser)
const CONSTANTS = {
  TILE_SIZE: 32,
  MAP: {                   // procedural sizes (level 1 uses the fixed 46x36 facility)
    SMALL: { width: 46, height: 36, coal: 6 },   // 1-2 players
    LARGE: { width: 54, height: 42, coal: 8 }    // 3-4 players
  },
  TILE_TYPES: {
    EMPTY: 0,
    FLOOR: 1,
    WALL: 2
  },
  PLAYER: {
    BASE_SPEED: 145,
    SPRINT_SPEED: 230,
    MAX_STAMINA: 100,
    STAMINA_DRAIN: 18,
    STAMINA_RECOVER: 35,
    INTERACTION_RADIUS: 55,
    REVIVE_RADIUS: 48,     // how close a teammate must stand to revive
    REVIVE_TIME: 2000,     // ms of holding E to pick someone up
    BLEEDOUT_TIME: 10000,  // ms a downed player waits before dying
    REVIVE_GRACE: 2000,    // ms Cobb can't grab someone just revived
    REVIVE_REFILL: 40,     // warmth / food a revived player comes back with
    WARMTH_MAX: 100,
    WARMTH_DRAIN: 3,       // per second away from heat (FREEZE)
    WARMTH_REGEN: 20,      // per second near the fire or a lit lamp
    HUNGER_MAX: 100,
    HUNGER_DRAIN: 1.5,     // per second (STARVE)
    CARROT_FOOD: 60,
    CARROT_RESPAWN: 25000,
    ROCK_MAX: 3,           // rocks you can carry
    ROCK_RANGE: 260
  },
  COBB: {
    WANDER_SPEED: 65,
    CHASE_SPEED: 105,
    INVESTIGATE_SPEED: 85, // walking to a noise or a scent
    AGGRO_RADIUS: 85,      // notices anyone this close, whatever the rules
    LOSE_RADIUS: 220,      // gives up the chase beyond this distance
    SEARCH_PAUSE: 2500,    // looks around this long where it lost you
    START_DELAY: 3000,     // head start at the beginning of a round
    REPATH_INTERVAL: 300,
    HIT_STUN: 2500,        // lingers after a grab
    ROCK_STUN: 2500,
    NORMAL_REACH: 30,
    LONG_REACH: 55,        // COBB CAN REACH
    FASTER_MUL: 1.45,      // COBB CAN BE FASTER
    CHASE_ACCEL: 0.06,     // FASTER: extra speed per second of chase...
    CHASE_ACCEL_MAX: 0.3,  // ...up to this much
    UNWATCHED_MUL: 1.6,    // COBB CAN'T MOVE: how fast it closes in when nobody lights it
    VISION_RANGE: 240,     // COBB CAN SEE, against a full lantern
    SHUTTERED_VISION: 90,  // against a shuttered lantern in the dark
    SMELL_RANGE: 220,
    SNIFF_INTERVAL: 4000,
    SEPARATION: 28         // duplicates keep at least this far apart
  },
  NOISE: {                 // radius each sound carries (COBB CAN HEAR)
    LIFE: 1500,
    SPRINT: 200,
    COAL: 120,
    DEPOSIT: 260,
    BREAKER: 300,
    ROCK: 320
  },
  TRAIL: {                 // scent breadcrumbs (COBB CAN SMELL)
    INTERVAL: 400,
    LIFE: 30000,
    MAX: 80
  },
  LIGHTS: {
    LANTERN_RADIUS: 140,
    LANTERN_STEALTH: 75,   // shuttered lantern
    FURNACE_RADIUS: 240,   // at full fuel
    EMBER_RADIUS: 70,      // a cold furnace still glows a little
    BRAZIER_RADIUS: 130,   // room lamps powered by breakers
    AMBIENT: 0x07070b,     // near-black: you see what your light shows you
    MAX_LIGHTS: 16
  },
  VERSUS: {
    COBB_SPEED: 150,       // a player-controlled Cobb: faster than walking, slower than sprinting
    MIN_PLAYERS: 2
  },
  RACE: {
    QUOTA: 3,              // coal each player must feed before their exit opens
    PLAYER_STUN: 1500      // a rock to the head stops a rival this long
  },
  TWISTS: {
    TETHER_RANGE: 320,     // TETHERED: farther than this from every teammate and Cobb knows
    HOT_COAL_TIME: 8000    // HOT_COAL: ms you can hold coal before it burns your hands
  },
  RECONNECT_HOLD: 30000,   // a dropped player's seat is kept this long
  // The furnace burns coal; while it burns, its light is a zone Cobb won't enter
  FURNACE: {
    START_FUEL: 60000,     // ms of fire at the start of a round
    FUEL_PER_COAL: 40000,
    MAX_FUEL: 90000,
    SAFE_SHARE: 0.75       // fraction of the light radius Cobb keeps out of
  }
};

// Furnace light radius for a given amount of fuel; shared so server and client agree
CONSTANTS.furnaceRadius = (fuel) => {
  const L = CONSTANTS.LIGHTS;
  return L.EMBER_RADIUS + (L.FURNACE_RADIUS - L.EMBER_RADIUS) * Math.min(1, fuel / CONSTANTS.FURNACE.MAX_FUEL);
};
CONSTANTS.safeRadius = (fuel) => (fuel > 0 ? CONSTANTS.furnaceRadius(fuel) * CONSTANTS.FURNACE.SAFE_SHARE : 0);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONSTANTS;
}
if (typeof window !== 'undefined') {
  window.CONSTANTS = CONSTANTS;
}
