// Server-side Cobb: grid pathfinding plus a small state machine.
// Pure logic (no sockets, no Node APIs) so it can be tested and later run in a browser.
const CONSTANTS = require('../shared/constants');

const TS = CONSTANTS.TILE_SIZE;
const FLOOR = CONSTANTS.TILE_TYPES.FLOOR;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const toTile = (v) => Math.floor(v / TS);
const tileCenter = (t) => t * TS + TS / 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const BLOCKED = 0;
const OPEN = 1;
const LIT = 2; // inside the burning furnace's safe zone: Cobb may only walk out of it

// walk[y][x]: BLOCKED for walls and the tiles under the furnace sprite, LIT inside the safe zone
function buildWalkGrid(mapData, safeRadius = 0) {
  const f = mapData.furnace;
  const fx = toTile(f.x);
  const fy = toTile(f.y);
  return mapData.grid.map((row, y) => row.map((t, x) => {
    if (t !== FLOOR || (Math.abs(x - fx) <= 1 && Math.abs(y - fy) <= 1)) return BLOCKED;
    return Math.hypot(tileCenter(x) - f.x, tileCenter(y) - f.y) < safeRadius ? LIT : OPEN;
  }));
}

const inSafeZone = (room, p) => dist(p, room.mapData.furnace) < (room.safeRadius || 0);

// Breadth-first search over 8 directions; diagonals only where both side tiles are open,
// so Cobb never cuts a wall corner. Lit tiles can be crossed only on the way out of the
// safe zone, never into it. Returns tile centres from the step after `from` to `to`.
// ponytail: plain BFS per repath, fine for a 46x36 grid; switch to A* if maps grow a lot.
function findPath(walk, from, to) {
  const h = walk.length;
  const w = walk[0].length;
  const cell = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? walk[y][x] : BLOCKED);
  const open = (x, y) => cell(x, y) !== BLOCKED;
  // A point on the furnace, or a player hugging it, can sit on a blocked tile;
  // use the nearest open tile within two steps instead
  const snap = (t) => {
    for (let r = 0; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (open(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
        }
      }
    }
    return null;
  };
  from = snap(from);
  to = snap(to);
  if (!from || !to) return null;

  const prev = new Int32Array(w * h).fill(-1);
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  prev[start] = start;
  const queue = [start];

  for (let i = 0; i < queue.length && prev[goal] === -1; i++) {
    const cur = queue[i];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!open(nx, ny) || (dx && dy && (!open(cx + dx, cy) || !open(cx, cy + dy)))) continue;
      if (cell(nx, ny) === LIT && cell(cx, cy) !== LIT) continue;
      const n = ny * w + nx;
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      queue.push(n);
    }
  }
  if (prev[goal] === -1) return null;

  const path = [];
  for (let n = goal; n !== start; n = prev[n]) {
    path.push({ x: tileCenter(n % w), y: tileCenter(Math.floor(n / w)) });
  }
  return path.reverse();
}

function createCobbs(mapData, now) {
  return [{
    id: 'cobb_0',
    x: mapData.cobbSpawn.x,
    y: mapData.cobbSpawn.y,
    flipX: false,
    state: 'WANDER',
    targetId: null,
    goal: null,
    path: [],
    repathAt: 0,
    lastSeen: null,
    lookUntil: 0,
    pauseUntil: now + CONSTANTS.COBB.START_DELAY
  }];
}

const isActive = (p) => p.role === 'SURVIVOR' && !p.isEscaped && !p.isDowned && !p.isDead;

// Returns false (and drops the goal) when there is no way there, so Cobb never walks
// straight through walls or into the safe zone
function setGoal(cobb, walk, goal) {
  const path = findPath(walk, { x: toTile(cobb.x), y: toTile(cobb.y) }, { x: toTile(goal.x), y: toTile(goal.y) });
  cobb.path = path || [];
  cobb.goal = path ? { x: goal.x, y: goal.y } : null;
  return !!path;
}

function pickWanderRoom(cobb, room) {
  const here = room.mapData.rooms.find(r =>
    toTile(cobb.x) >= r.x && toTile(cobb.x) < r.x + r.w && toTile(cobb.y) >= r.y && toTile(cobb.y) < r.y + r.h);
  // Stay out of the furnace hub (room 0) while wandering, like the original level 1
  const choices = room.mapData.rooms.filter(r => r.id !== 0 && r !== here);
  const r = choices[Math.floor(Math.random() * choices.length)];
  setGoal(cobb, room.walk, { x: tileCenter(r.centerX), y: tileCenter(r.centerY) });
}

// Players Cobb can go after: standing, and not sheltering in the furnace's light
const isPrey = (room, p) => isActive(p) && !inSafeZone(room, p);

function nearestPrey(cobb, room, radius) {
  let best = null;
  room.players.forEach((p) => {
    const d = dist(cobb, p);
    if (isPrey(room, p) && d <= radius && (!best || d < best.d)) best = { p, d };
  });
  return best && best.p;
}

// Follow the path, then walk straight at the goal point inside its final tile
function moveAlong(cobb, speed, dt) {
  let step = speed * dt;
  while (step > 0) {
    const next = cobb.path[0] || cobb.goal;
    if (!next) return true;
    const d = dist(cobb, next);
    if (d > 0.5) cobb.flipX = next.x < cobb.x;
    if (d <= step) {
      cobb.x = next.x;
      cobb.y = next.y;
      step -= d;
      if (cobb.path.length) {
        cobb.path.shift();
      } else {
        return true; // reached the goal
      }
    } else {
      cobb.x += ((next.x - cobb.x) / d) * step;
      cobb.y += ((next.y - cobb.y) / d) * step;
      step = 0;
    }
  }
  return false;
}

// Advance one Cobb by dt seconds. Returns the player it grabbed this step, if any.
// pauseUntil makes Cobb fully inert (round start, after a grab);
// lookUntil only stops it walking while it searches.
function stepCobb(cobb, room, dt, now) {
  if (now < cobb.pauseUntil) return null;
  const C = CONSTANTS.COBB;
  const players = room.players;

  if (cobb.state !== 'CHASE') {
    const seen = nearestPrey(cobb, room, C.AGGRO_RADIUS);
    if (seen) {
      cobb.state = 'CHASE';
      cobb.targetId = seen.id;
      cobb.repathAt = 0;
    }
  }

  let speed = C.WANDER_SPEED;
  if (cobb.state === 'CHASE') {
    const target = players.get(cobb.targetId);
    if (!target || !isActive(target) || dist(cobb, target) > C.LOSE_RADIUS) {
      // Lost them: walk to where they were last seen and look around
      cobb.state = 'SEARCH';
      cobb.targetId = null;
      if (!setGoal(cobb, room.walk, cobb.lastSeen || cobb)) cobb.state = 'WANDER';
    } else if (inSafeZone(room, target)) {
      // They reached the fire; Cobb backs off
      cobb.state = 'WANDER';
      cobb.targetId = null;
      cobb.goal = null;
      cobb.path = [];
    } else {
      speed = C.CHASE_SPEED;
      cobb.lastSeen = { x: target.x, y: target.y };
      if (now >= cobb.repathAt) {
        cobb.repathAt = now + C.REPATH_INTERVAL;
        if (!setGoal(cobb, room.walk, target)) cobb.state = 'WANDER';
      } else if (cobb.goal) {
        cobb.goal = { x: target.x, y: target.y };
      }
    }
  }

  // Looking around stops Cobb's feet, not its senses or its hands
  if (cobb.state === 'CHASE') cobb.lookUntil = 0;
  if (now >= (cobb.lookUntil || 0)) {
    if (cobb.state === 'WANDER' && !cobb.goal) pickWanderRoom(cobb, room);

    const arrived = moveAlong(cobb, speed, dt);
    if (arrived && cobb.state === 'SEARCH') {
      cobb.state = 'WANDER';
      cobb.goal = null;
      cobb.lookUntil = now + C.SEARCH_PAUSE;
    } else if (arrived && cobb.state === 'WANDER') {
      cobb.goal = null;
    }
  }

  for (const p of players.values()) {
    if (isPrey(room, p) && now >= (p.safeUntil || 0) && dist(cobb, p) <= C.NORMAL_REACH) {
      // Grabbed: Cobb lingers, then loses interest and wanders off
      cobb.state = 'WANDER';
      cobb.targetId = null;
      cobb.goal = null;
      cobb.pauseUntil = now + C.HIT_STUN;
      return p;
    }
  }
  return null;
}

module.exports = { buildWalkGrid, findPath, createCobbs, stepCobb, isActive, LIT };
