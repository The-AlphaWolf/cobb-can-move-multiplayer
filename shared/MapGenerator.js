// Universal MapGenerator for both Client and Server
class MapGenerator {
  constructor(seed = Math.random()) {
    this.seed = seed;
    this.random = this.createSeededRandom(seed);
  }

  createSeededRandom(s) {
    let t = typeof s === 'string' ? this.hashString(s) : s;
    return () => {
      t = Math.sin(t) * 10000;
      return t - Math.floor(t);
    };
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) || 1;
  }

  randInt(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  generate(width = 46, height = 36, options = {}) {
    const coalRequired = options.coalCount || 6;

    // 1. Initialize entire map as solid WALLS (no void leaks!)
    const grid = Array.from({ length: height }, () => Array(width).fill(2));
    const rooms = [];

    // 2. Define clean, guaranteed connected rooms with generous spaces
    const roomDefs = [
      { id: 0, x: 15, y: 11, w: 16, h: 14, name: 'Furnace Hub' },
      { id: 1, x: 3,  y: 3,  w: 10, h: 8,  name: 'Top-Left Wing' },
      { id: 2, x: 33, y: 3,  w: 10, h: 8,  name: 'Top-Right Wing' },
      { id: 3, x: 3,  y: 25, w: 10, h: 8,  name: 'Bottom-Left Wing' },
      { id: 4, x: 33, y: 25, w: 10, h: 8,  name: 'Bottom-Right Wing' },
      { id: 5, x: 17, y: 2,  w: 12, h: 7,  name: 'North Chamber' },
      { id: 6, x: 17, y: 27, w: 12, h: 7,  name: 'South Exit' }
    ];

    roomDefs.forEach((r) => {
      const room = {
        id: r.id,
        name: r.name,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        centerX: Math.floor(r.x + r.w / 2),
        centerY: Math.floor(r.y + r.h / 2)
      };
      rooms.push(room);

      // Carve floor
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          grid[y][x] = 1; // Floor
        }
      }
    });

    // 3. Helper to carve wide 3-tile corridors
    const carveH = (x1, x2, y) => {
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      for (let x = minX; x <= maxX; x++) {
        for (let dy = 0; dy < 3; dy++) {
          if (y + dy < height - 1 && y + dy > 0 && x > 0 && x < width - 1) {
            grid[y + dy][x] = 1;
          }
        }
      }
    };

    const carveV = (x, y1, y2) => {
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      for (let y = minY; y <= maxY; y++) {
        for (let dx = 0; dx < 3; dx++) {
          if (x + dx < width - 1 && x + dx > 0 && y > 0 && y < height - 1) {
            grid[y][x + dx] = 1;
          }
        }
      }
    };

    // Central Hub wide connections (North, South, East, West - all 3 tiles wide!)
    carveV(21, 8, 12);  // Hub North to North Chamber
    carveV(21, 24, 28); // Hub South to South Exit
    carveH(7, 16, 17);  // Hub West to West Corridor Spine
    carveH(30, 39, 17); // Hub East to East Corridor Spine

    // West & East vertical corridor spines (connecting top & bottom wings)
    carveV(7, 10, 26);  // West spine
    carveV(36, 10, 26); // East spine

    // Top & Bottom perimeter loop corridors
    carveH(12, 18, 5);  // Top-Left Wing to North Chamber
    carveH(28, 34, 5);  // North Chamber to Top-Right Wing
    carveH(12, 18, 28); // Bottom-Left Wing to South Exit
    carveH(28, 34, 28); // South Exit to Bottom-Right Wing

    // 4. Outer perimeter border is always solid walls
    for (let x = 0; x < width; x++) {
      grid[0][x] = 2;
      grid[height - 1][x] = 2;
    }
    for (let y = 0; y < height; y++) {
      grid[y][0] = 2;
      grid[y][width - 1] = 2;
    }

    const furnaceRoom = rooms[0]; // Center hub (23, 18)
    const exitRoom = rooms[6];    // South chamber
    const cobbRoom = rooms[2];    // Top-right wing

    // 5. Place interactive items in open, accessible positions
    const coal = [
      { id: 'coal_0', x: 6 * 32 + 16, y: 5 * 32 + 16, collected: false },
      { id: 'coal_1', x: 9 * 32 + 16, y: 8 * 32 + 16, collected: false },
      { id: 'coal_2', x: 38 * 32 + 16, y: 6 * 32 + 16, collected: false },
      { id: 'coal_3', x: 8 * 32 + 16, y: 29 * 32 + 16, collected: false },
      { id: 'coal_4', x: 38 * 32 + 16, y: 29 * 32 + 16, collected: false },
      { id: 'coal_5', x: 23 * 32 + 16, y: 4 * 32 + 16, collected: false }
    ];

    // Each breaker powers the lamps of one side of the facility
    const lampAt = (r) => ({ x: r.centerX * 32 + 16, y: r.centerY * 32 + 16 });
    const breakers = [
      { id: 'breaker_0', x: 8 * 32 + 16, y: 3 * 32 + 16, active: false, lamps: [1, 5, 2].map(i => lampAt(rooms[i])) },
      { id: 'breaker_1', x: 38 * 32 + 16, y: 25 * 32 + 16, active: false, lamps: [3, 6, 4].map(i => lampAt(rooms[i])) }
    ];

    const at = ([x, y]) => ({ x: x * 32 + 16, y: y * 32 + 16 });
    // Throwable rocks, and carrots that matter only under STARVE
    const rocks = [[11, 9], [34, 4], [5, 27], [41, 31], [19, 30], [18, 13]]
      .map((p, i) => ({ id: `rock_s${i}`, ...at(p) }));
    const carrots = [[4, 9], [41, 9], [11, 31], [26, 7]]
      .map((p, i) => ({ id: `carrot_${i}`, ...at(p), respawnAt: 0 }));

    return {
      width,
      height,
      grid,
      rooms,
      rocks,
      carrots,
      furnace: {
        x: furnaceRoom.centerX * 32 + 16,
        y: furnaceRoom.centerY * 32 + 16,
        coalDeposited: 0,
        coalRequired,
        fuel: 0 // set when a round starts
      },
      exit: {
        x: exitRoom.centerX * 32 + 16,
        y: 33 * 32 + 16, // Open doorway threshold at bottom of South Chamber
        unlocked: false
      },
      playerSpawns: [
        { x: (furnaceRoom.centerX - 3) * 32 + 16, y: furnaceRoom.centerY * 32 + 16 },
        { x: (furnaceRoom.centerX + 3) * 32 + 16, y: furnaceRoom.centerY * 32 + 16 },
        { x: furnaceRoom.centerX * 32 + 16, y: (furnaceRoom.centerY - 3) * 32 + 16 },
        { x: furnaceRoom.centerX * 32 + 16, y: (furnaceRoom.centerY + 3) * 32 + 16 }
      ],
      cobbSpawn: {
        x: cobbRoom.centerX * 32 + 16,
        y: cobbRoom.centerY * 32 + 16
      },
      coal,
      breakers
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MapGenerator;
}
if (typeof window !== 'undefined') {
  window.MapGenerator = MapGenerator;
}
