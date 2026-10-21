window.CONSTANTS = {
  TILE_SIZE: 32,
  PLAYER: {
    BASE_SPEED: 145,
    SPRINT_SPEED: 230,
    MAX_STAMINA: 100,
    STAMINA_DRAIN: 18,    // 50% slower drain (run much longer)
    STAMINA_RECOVER: 35,  // Faster recovery
    INTERACTION_RADIUS: 55
  },
  COBB: {
    WANDER_SPEED: 65,     // Relaxed lumbering walk
    CHASE_SPEED: 105,     // Manageable chase (slower than player base 145!)
    AGGRO_RADIUS: 85,     // Only notices if very close
    CHASE_DURATION: 3500, // Gives up after 3.5s
    HIT_STUN: 2500        // Stunned for 2.5s after attacking so player escapes
  },
  LIGHTS: {
    LANTERN_RADIUS: 140,
    LANTERN_STEALTH: 75,
    FURNACE_RADIUS: 240,
    AMBIENT_DARK: 0x050508
  },
  RULES: {
    COBB_MOVE: 'COBB CAN MOVE',
    COBB_SEE: 'COBB CAN SEE',
    COBB_HEAR: 'COBB CAN HEAR',
    COBB_SMELL: 'COBB CAN SMELL',
    COBB_REACH: 'COBB CAN REACH',
    COBB_DUPLICATE: 'COBB CAN DUPLICATE',
    COBB_FASTER: 'COBB CAN BE FASTER',
    COBB_CANT_MOVE: "COBB CAN'T MOVE"
  }
};
