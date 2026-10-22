// Map generation. Level 1 uses a fixed, learnable facility (classic()); every other level gets a
// fresh seeded layout from generate(). Both return the same shape:
// { width, height, grid, rooms, furnace, exit, playerSpawns, cobbSpawn, coal, breakers, rocks, carrots }
// Room 0 is always the furnace hub.
const FLOOR = 1;
const WALL = 2;
const T = 32;

const center = (t) => t * T + T / 2;
const at = ([x, y]) => ({ x: center(x), y: center(y) });

// mulberry32: tiny, fast, well-distributed 32-bit PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MapGenerator {
  constructor(seed = Date.now()) {
    this.seed = seed >>> 0;
    this.random = mulberry32(this.seed);
  }

  randInt(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // A fresh facility: rooms around a central furnace hub, joined by a minimum spanning tree of
  // 3-wide corridors plus extra links so chases can loop. Retries until everything fits.
  // fireZone: radius (px) of the burning fire's no-go zone for Cobb; layouts where that zone
  // would cut Cobb off from part of the facility are rejected.
  generate(width = 46, height = 36, { coalCount = 6, fireZone = 0 } = {}) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const map = this.tryGenerate(width, height, coalCount, fireZone);
      if (map) return { ...map, seed: this.seed };
    }
    throw new Error(`Could not generate a ${width}x${height} map from seed ${this.seed}`);
  }

  tryGenerate(width, height, coalCount, fireZone) {
    const grid = Array.from({ length: height }, () => Array(width).fill(WALL));
    const inside = (x, y) => x > 0 && y > 0 && x < width - 1 && y < height - 1;
    const carve = (x, y) => { if (inside(x, y)) grid[y][x] = FLOOR; };

    // 1. Rooms: the hub near the middle, then non-overlapping rooms with walls between them
    const room = (id, name, x, y, w, h) => ({
      id, name, x, y, w, h, centerX: Math.floor(x + w / 2), centerY: Math.floor(y + h / 2)
    });
    const hw = this.randInt(12, 14);
    const hh = this.randInt(10, 12);
    const rooms = [room(0, 'Furnace Hub',
      Math.floor((width - hw) / 2) + this.randInt(-2, 2),
      Math.floor((height - hh) / 2) + this.randInt(-2, 2), hw, hh)];
    // About one wing per 230 tiles: 12 on the smallest procedural map, 22 on the largest
    const target = Math.min(24, Math.round((width * height) / 230));
    const overlaps = (r) => rooms.some(o =>
      r.x < o.x + o.w + 3 && o.x < r.x + r.w + 3 && r.y < o.y + o.h + 3 && o.y < r.y + r.h + 3);
    for (let i = 0; i < 1500 && rooms.length < target; i++) {
      const w = this.randInt(7, 12);
      const h = this.randInt(6, 10);
      const r = room(rooms.length, `Wing ${String.fromCharCode(64 + rooms.length)}`,
        this.randInt(2, width - w - 2), this.randInt(2, height - h - 2), w, h);
      if (!overlaps(r)) rooms.push(r);
    }
    if (rooms.length < target - 2) return null;
    rooms.forEach((r) => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y);
    });

    // 2. Corridors: Prim's MST over room centres, then the two shortest leftover links (loops)
    const dist = (a, b) => Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY);
    const edges = [];
    const joined = new Set([0]);
    while (joined.size < rooms.length) {
      let best = null;
      joined.forEach((i) => rooms.forEach((r, j) => {
        if (!joined.has(j) && (!best || dist(rooms[i], r) < best.d)) best = { i, j, d: dist(rooms[i], r) };
      }));
      joined.add(best.j);
      edges.push([best.i, best.j]);
    }
    const linked = new Set(edges.map(([i, j]) => `${Math.min(i, j)}-${Math.max(i, j)}`));
    const extra = [];
    rooms.forEach((a, i) => rooms.forEach((b, j) => {
      if (i < j && !linked.has(`${i}-${j}`)) extra.push({ i, j, d: dist(a, b) });
    }));
    // Loops that bypass the hub, so the facility is still a circuit while the fire burns.
    // Roughly one extra link per three wings: plenty of ways around a Cobb in your path.
    const loops = Math.max(3, Math.ceil(rooms.length / 3));
    extra.filter(e => e.i !== 0 && e.j !== 0).sort((a, b) => a.d - b.d).slice(0, loops).forEach(e => edges.push([e.i, e.j]));

    const corridor = (a, b) => {
      const horizontalFirst = this.random() < 0.5;
      const cornerX = horizontalFirst ? b.centerX : a.centerX;
      const cornerY = horizontalFirst ? a.centerY : b.centerY;
      const line = (x1, y1, x2, y2) => {
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
          for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
            for (let d = -1; d <= 1; d++) {
              if (y1 === y2) carve(x, y + d); else carve(x + d, y);
            }
          }
        }
      };
      line(a.centerX, a.centerY, cornerX, cornerY);
      line(cornerX, cornerY, b.centerX, b.centerY);
    };
    edges.forEach(([i, j]) => corridor(rooms[i], rooms[j]));

    // 3. Everything must be reachable from the hub; distances guide where things go
    const hub = rooms[0];
    const steps = Array.from({ length: height }, () => Array(width).fill(-1));
    const queue = [[hub.centerX, hub.centerY]];
    steps[hub.centerY][hub.centerX] = 0;
    let reached = 0;
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i];
      reached++;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (grid[ny][nx] === FLOOR && steps[ny][nx] === -1) {
          steps[ny][nx] = steps[y][x] + 1;
          queue.push([nx, ny]);
        }
      });
    }
    const floorCount = grid.reduce((n, row) => n + row.filter(t => t === FLOOR).length, 0);
    if (reached !== floorCount) return null;

    // 4. Landmarks: the exit in the room farthest from the fire, Cobb in the next farthest
    const far = rooms.slice(1).sort((a, b) => steps[b.centerY][b.centerX] - steps[a.centerY][a.centerX]);
    const exitRoom = far[0];
    const cobbRoom = far[1];

    // Cobb must be able to reach every wing without crossing the fire's light
    if (fireZone > 0) {
      const fx = center(hub.centerX);
      const fy = center(hub.centerY);
      const open = (x, y) => grid[y][x] === FLOOR && Math.hypot(center(x) - fx, center(y) - fy) >= fireZone;
      const seen = new Set([`${cobbRoom.centerX},${cobbRoom.centerY}`]);
      const todo = [[cobbRoom.centerX, cobbRoom.centerY]];
      for (let i = 0; i < todo.length; i++) {
        const [x, y] = todo[i];
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const k = `${x + dx},${y + dy}`;
          if (!seen.has(k) && open(x + dx, y + dy)) {
            seen.add(k);
            todo.push([x + dx, y + dy]);
          }
        });
      }
      if (rooms.slice(1).some(r => !seen.has(`${r.centerX},${r.centerY}`))) return null;
    }

    // 5. Items on free floor tiles, spread apart; never under the furnace or on a spawn
    const used = new Set();
    const key = (x, y) => `${x},${y}`;
    const nearUsed = (x, y, gap) => {
      for (const k of used) {
        const [ux, uy] = k.split(',').map(Number);
        if (Math.max(Math.abs(ux - x), Math.abs(uy - y)) < gap) return true;
      }
      return false;
    };
    const reserve = (x, y) => used.add(key(x, y));
    reserve(hub.centerX, hub.centerY);
    const spawns = [[-3, 0], [3, 0], [0, -3], [0, 3]].map(([dx, dy]) => [hub.centerX + dx, hub.centerY + dy]);
    spawns.forEach(([x, y]) => reserve(x, y));
    const exitTile = [exitRoom.centerX, exitRoom.y + exitRoom.h - 1];
    reserve(...exitTile);

    const tilesOf = (list) => {
      const out = [];
      list.forEach((r) => {
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
      });
      return this.shuffle(out);
    };
    const pick = (count, candidates, gap, ok = () => true) => {
      const chosen = [];
      for (const [x, y] of candidates) {
        if (chosen.length === count) break;
        if (grid[y][x] !== FLOOR || used.has(key(x, y)) || nearUsed(x, y, gap) || !ok(x, y)) continue;
        reserve(x, y);
        chosen.push([x, y]);
      }
      return chosen.length === count ? chosen : null;
    };

    const wings = rooms.slice(1);
    // Coal sits well away from the fire, so feeding it means a real trip
    const coalTiles = pick(coalCount, tilesOf(wings), 4, (x, y) => steps[y][x] >= 12)
      || pick(coalCount, tilesOf(wings), 3, (x, y) => steps[y][x] >= 8);
    if (!coalTiles) return null;

    // Breakers: one per half of the facility (west/east of the hub), each lighting its half's rooms
    const halves = [wings.filter(r => r.centerX < hub.centerX), wings.filter(r => r.centerX >= hub.centerX)]
      .filter(h => h.length);
    const breakers = [];
    for (const [i, half] of halves.entries()) {
      const spot = pick(1, tilesOf(half), 2);
      if (!spot) return null;
      breakers.push({
        id: `breaker_${i}`,
        ...at(spot[0]),
        active: false,
        lamps: half.map(r => at([r.centerX, r.centerY]))
      });
    }

    // More floor, more rocks to throw and carrots to find
    const rockTiles = pick(Math.round((width * height) / 400), tilesOf(rooms), 3, (x, y) => steps[y][x] >= 4);
    const carrotTiles = pick(Math.max(4, Math.round((width * height) / 650)), tilesOf(wings), 5);
    if (!rockTiles || !carrotTiles) return null;

    return {
      width,
      height,
      grid,
      rooms,
      rocks: rockTiles.map((p, i) => ({ id: `rock_s${i}`, ...at(p) })),
      carrots: carrotTiles.map((p, i) => ({ id: `carrot_${i}`, ...at(p), respawnAt: 0 })),
      furnace: { ...at([hub.centerX, hub.centerY]), coalDeposited: 0, coalRequired: coalCount, fuel: 0 },
      exit: { ...at(exitTile), unlocked: false },
      playerSpawns: spawns.map(at),
      cobbSpawn: at([cobbRoom.centerX, cobbRoom.centerY]),
      coal: coalTiles.map((p, i) => ({ id: `coal_${i}`, ...at(p), collected: false })),
      breakers
    };
  }

  // The hand-made level 1 facility: a hub, four wings, two chambers and a loop around them
  classic() {
    const width = 46;
    const height = 36;
    const grid = Array.from({ length: height }, () => Array(width).fill(WALL));
    const rooms = [
      { id: 0, x: 15, y: 11, w: 16, h: 14, name: 'Furnace Hub' },
      { id: 1, x: 3, y: 3, w: 10, h: 8, name: 'Top-Left Wing' },
      { id: 2, x: 33, y: 3, w: 10, h: 8, name: 'Top-Right Wing' },
      { id: 3, x: 3, y: 25, w: 10, h: 8, name: 'Bottom-Left Wing' },
      { id: 4, x: 33, y: 25, w: 10, h: 8, name: 'Bottom-Right Wing' },
      { id: 5, x: 17, y: 2, w: 12, h: 7, name: 'North Chamber' },
      { id: 6, x: 17, y: 27, w: 12, h: 7, name: 'South Exit' }
    ].map(r => ({ ...r, centerX: Math.floor(r.x + r.w / 2), centerY: Math.floor(r.y + r.h / 2) }));

    rooms.forEach((r) => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = FLOOR;
    });

    // 3-tile corridors
    const carveH = (x1, x2, y) => {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let dy = 0; dy < 3; dy++) grid[y + dy][x] = FLOOR;
      }
    };
    const carveV = (x, y1, y2) => {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        for (let dx = 0; dx < 3; dx++) grid[y][x + dx] = FLOOR;
      }
    };
    carveV(21, 8, 12);  // hub to North Chamber
    carveV(21, 24, 28); // hub to South Exit
    carveH(7, 16, 17);  // hub to west spine
    carveH(30, 39, 17); // hub to east spine
    carveV(7, 10, 26);  // west spine
    carveV(36, 10, 26); // east spine
    carveH(12, 18, 5);  // top loop
    carveH(28, 34, 5);
    carveH(12, 18, 28); // bottom loop
    carveH(28, 34, 28);

    const hub = rooms[0];
    const lamps = ids => ids.map(i => at([rooms[i].centerX, rooms[i].centerY]));
    return {
      width,
      height,
      grid,
      rooms,
      rocks: [[11, 9], [34, 4], [5, 27], [41, 31], [19, 30], [18, 13]].map((p, i) => ({ id: `rock_s${i}`, ...at(p) })),
      carrots: [[4, 9], [41, 9], [11, 31], [26, 7]].map((p, i) => ({ id: `carrot_${i}`, ...at(p), respawnAt: 0 })),
      furnace: { ...at([hub.centerX, hub.centerY]), coalDeposited: 0, coalRequired: 6, fuel: 0 },
      exit: { ...at([rooms[6].centerX, 33]), unlocked: false },
      playerSpawns: [[-3, 0], [3, 0], [0, -3], [0, 3]].map(([dx, dy]) => at([hub.centerX + dx, hub.centerY + dy])),
      cobbSpawn: at([rooms[2].centerX, rooms[2].centerY]),
      coal: [[6, 5], [9, 8], [38, 6], [8, 29], [38, 29], [23, 4]]
        .map((p, i) => ({ id: `coal_${i}`, ...at(p), collected: false })),
      breakers: [
        { id: 'breaker_0', ...at([8, 3]), active: false, lamps: lamps([1, 5, 2]) },
        { id: 'breaker_1', ...at([38, 25]), active: false, lamps: lamps([3, 6, 4]) }
      ]
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MapGenerator;
}
