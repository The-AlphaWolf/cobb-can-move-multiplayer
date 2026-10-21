// Simulation checks for server-side Cobb, downing, reviving and round results. No sockets.
// Run with: npm test
const assert = require('assert');
const RoomManager = require('../server/RoomManager');
const { findPath, stepCobb } = require('../server/cobb');
const { tickRoom, roundResult } = require('../server/game');
const CONSTANTS = require('../shared/constants');

const TS = CONSTANTS.TILE_SIZE;
const tile = (v) => Math.floor(v / TS);

const rm = new RoomManager();
const room = rm.createRoom('a');
rm.addPlayer(room.code, 'a', { name: 'A' });
rm.addPlayer(room.code, 'b', { name: 'B' });
rm.startRound(room);
const a = room.players.get('a');
const b = room.players.get('b');
const cobb = room.cobbs[0];
let now = Date.now() + 10000; // past Cobb's start delay

// 1. Paths reach every room, move one tile at a time, and never cut a wall corner
const start = { x: tile(cobb.x), y: tile(cobb.y) };
room.mapData.rooms.forEach((r) => {
  const path = findPath(room.walk, start, { x: r.centerX, y: r.centerY });
  assert(path, `no path to ${r.name}`); // empty when Cobb already stands there
  let prev = start;
  path.forEach((p) => {
    const t = { x: tile(p.x), y: tile(p.y) };
    assert(room.walk[t.y][t.x], 'path crosses a blocked tile');
    const dx = t.x - prev.x;
    const dy = t.y - prev.y;
    assert(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, 'path skips a tile');
    if (dx && dy) assert(room.walk[prev.y][prev.x + dx] && room.walk[prev.y + dy][prev.x], 'diagonal cuts a corner');
    prev = t;
  });
});

// 2. Wandering for two simulated minutes never puts Cobb inside a wall
a.isEscaped = b.isEscaped = true; // nobody to chase
for (let i = 0; i < 2400; i++, now += 50) {
  stepCobb(cobb, room, 0.05, now);
  assert.strictEqual(room.mapData.grid[tile(cobb.y)][tile(cobb.x)], CONSTANTS.TILE_TYPES.FLOOR, 'Cobb walked into a wall');
}
a.isEscaped = b.isEscaped = false;

// 3. A player inside aggro range gets chased
Object.assign(cobb, { state: 'WANDER', goal: null, path: [], pauseUntil: 0 });
a.x = cobb.x + CONSTANTS.COBB.AGGRO_RADIUS - 10;
a.y = cobb.y;
b.x = b.y = 5000; // far away
stepCobb(cobb, room, 0.05, now);
assert.strictEqual(cobb.state, 'CHASE');
assert.strictEqual(cobb.targetId, 'a');

// 3b. A Cobb standing still to look around still notices and grabs
Object.assign(cobb, { state: 'WANDER', targetId: null, goal: null, path: [], lookUntil: now + 60000 });
a.x = cobb.x + 10;
a.y = cobb.y;
assert.strictEqual(stepCobb(cobb, room, 0.05, now), a, 'looking-around Cobb should still grab');
a.isDowned = false;
Object.assign(cobb, { state: 'CHASE', targetId: 'a', pauseUntil: 0, lookUntil: 0 });

// 4. Touching Cobb downs the player and drops their coal where they fell
const coal = room.mapData.coal[0];
coal.collected = true;
a.hasCoal = true;
a.coalId = coal.id;
a.x = cobb.x + 5;
a.y = cobb.y;
let events = tickRoom(room, 50, now);
const names = events.map(e => e[0]);
assert(names.includes('player:downed'));
assert(names.includes('coal:dropped'));
assert(a.isDowned && !a.hasCoal && !coal.collected);
assert.strictEqual(coal.x, Math.round(a.x));

// 5. A teammate holding E next to them revives them; Cobb can't instantly re-grab
cobb.pauseUntil = now + 60000;
b.x = a.x + 20;
b.y = a.y;
b.reviving = true;
let revived = false;
for (let t = 0; t <= CONSTANTS.PLAYER.REVIVE_TIME + 100 && !revived; t += 50, now += 50) {
  revived = tickRoom(room, 50, now).some(e => e[0] === 'player:revived');
}
assert(revived && !a.isDowned && a.safeUntil > now);
b.reviving = false;

// 6. Left alone, a downed player bleeds out
a.isDowned = true;
a.bleedLeft = 100;
events = tickRoom(room, 150, now);
assert(events.some(e => e[0] === 'player:died'));
assert(a.isDead && !a.isDowned);

// 7. Results: round continues while someone stands; ends won if anyone escaped, else lost with a tip
assert.strictEqual(roundResult(room), null);
b.isEscaped = true;
assert.strictEqual(roundResult(room).won, true);
b.isEscaped = false;
b.isDowned = true; // downed with nobody left to help
const lost = roundResult(room);
assert(lost && !lost.won && lost.tip);
assert.deepStrictEqual(lost.players.map(p => p.status), ['caught', 'caught']);

console.log('PASS game simulation');
