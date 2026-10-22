// Procedural map checks over many seeds: determinism, connectivity, item placement, Cobb paths.
// Run with: npm test
const assert = require('assert');
const MapGenerator = require('../shared/MapGenerator');
const { buildWalkGrid, findPath } = require('../server/cobb');
const CONSTANTS = require('../shared/constants');

const FLOOR = CONSTANTS.TILE_TYPES.FLOOR;
const tile = v => Math.floor(v / 32);
const tileOf = p => [tile(p.x), tile(p.y)];

function stepsFrom(grid, [sx, sy]) {
  const steps = grid.map(row => row.map(() => -1));
  steps[sy][sx] = 0;
  const queue = [[sx, sy]];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
      if (grid[y + dy][x + dx] === FLOOR && steps[y + dy][x + dx] === -1) {
        steps[y + dy][x + dx] = steps[y][x] + 1;
        queue.push([x + dx, y + dy]);
      }
    });
  }
  return steps;
}

// 1. Same seed, same map
const a = new MapGenerator(1234).generate(46, 36);
const b = new MapGenerator(1234).generate(46, 36);
assert.deepStrictEqual(a, b, 'generation must be deterministic per seed');
assert.notDeepStrictEqual(a.grid, new MapGenerator(1235).generate(46, 36).grid, 'different seeds should differ');

let slowest = 0;
for (const size of CONSTANTS.MAP_TIERS) {
  for (let seed = 1; seed <= 300; seed++) {
    const started = Date.now();
    const fireZone = CONSTANTS.LIGHTS.FURNACE_RADIUS * CONSTANTS.FURNACE.SAFE_SHARE;
    const map = new MapGenerator(seed).generate(size.width, size.height, { coalCount: size.coal, fireZone });
    slowest = Math.max(slowest, Date.now() - started);
    const { grid, width, height } = map;
    const where = `seed ${seed} ${width}x${height}`;

    // 2. Solid border, and every floor tile reachable from the furnace
    for (let x = 0; x < width; x++) assert(grid[0][x] !== FLOOR && grid[height - 1][x] !== FLOOR, where);
    for (let y = 0; y < height; y++) assert(grid[y][0] !== FLOOR && grid[y][width - 1] !== FLOOR, where);
    const steps = stepsFrom(grid, tileOf(map.furnace));
    grid.forEach((row, y) => row.forEach((t, x) => {
      if (t === FLOOR) assert(steps[y][x] >= 0, `${where}: floor (${x},${y}) cut off`);
    }));

    // 3. Everything stands on reachable floor, one thing per tile
    const things = [map.exit, map.cobbSpawn, ...map.playerSpawns, ...map.coal, ...map.rocks, ...map.carrots, ...map.breakers];
    const seen = new Set();
    things.forEach((p) => {
      const [x, y] = tileOf(p);
      assert.strictEqual(grid[y][x], FLOOR, `${where}: item off the floor`);
      assert(steps[y][x] >= 0, `${where}: item unreachable`);
      if (p !== map.cobbSpawn) {
        assert(!seen.has(`${x},${y}`), `${where}: two items share a tile`);
        seen.add(`${x},${y}`);
      }
    });

    // 4. The furnace is in hub room 0; coal makes you travel; the exit is far away
    const hub = map.rooms[0];
    const [fx, fy] = tileOf(map.furnace);
    assert(fx >= hub.x && fx < hub.x + hub.w && fy >= hub.y && fy < hub.y + hub.h, `${where}: furnace outside hub`);
    assert.strictEqual(map.coal.length, size.coal);
    map.coal.forEach(c => assert(steps[tile(c.y)][tile(c.x)] >= 8, `${where}: coal too close to the fire`));
    assert(steps[tile(map.exit.y)][tile(map.exit.x)] >= 10, `${where}: exit too close`);
    map.playerSpawns.forEach((s) => {
      const [x, y] = tileOf(s);
      assert(Math.max(Math.abs(x - fx), Math.abs(y - fy)) >= 2, `${where}: spawn on the furnace`);
    });
    assert(map.breakers.length >= 1 && map.breakers.every(br => br.lamps.length > 0), `${where}: breakers`);

    // 5. Cobb can walk from its spawn to every wing, even around a fully fed fire
    const walk = buildWalkGrid(map, fireZone);
    const from = { x: tile(map.cobbSpawn.x), y: tile(map.cobbSpawn.y) };
    map.rooms.slice(1).forEach((r) => {
      assert(findPath(walk, from, { x: r.centerX, y: r.centerY }), `${where}: Cobb can't reach ${r.name}`);
    });
  }
}
assert(slowest < 400, `generation too slow: ${slowest} ms`);

// 6. The level 1 facility is unchanged
const classic = new MapGenerator(1).classic();
assert.strictEqual(classic.rooms.length, 7);
assert.deepStrictEqual(tileOf(classic.exit), [23, 33]);

console.log(`PASS map generation (slowest ${slowest} ms)`);
