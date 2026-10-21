// Server-side Cobb: grid pathfinding, senses and a small state machine.
// Pure logic (no sockets, no Node APIs) so it can be tested and later run in a browser.
const CONSTANTS = require('../shared/constants');

const TS = CONSTANTS.TILE_SIZE;
const FLOOR = CONSTANTS.TILE_TYPES.FLOOR;
const C = CONSTANTS.COBB;
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
// ponytail: plain BFS per repath, fine for maps this size; switch to A* if maps grow a lot.
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

// True when nothing but floor lies between two points
function lineOfSight(grid, a, b) {
  const steps = Math.ceil(dist(a, b) / 8);
  for (let i = 1; i < steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    if (grid[toTile(y)][toTile(x)] !== FLOOR) return false;
  }
  return true;
}

// The first Cobb starts at the map's Cobb spawn; duplicates take the rooms farthest from the fire
function createCobbs(mapData, now, count = 1) {
  const f = mapData.furnace;
  const far = mapData.rooms
    .filter(r => r.id !== 0)
    .map(r => ({ x: tileCenter(r.centerX), y: tileCenter(r.centerY) }))
    .filter(p => dist(p, mapData.cobbSpawn) > TS)
    .sort((a, b) => dist(b, f) - dist(a, f));
  const spots = [mapData.cobbSpawn, ...far];
  return Array.from({ length: count }, (_, i) => ({
    id: `cobb_${i}`,
    x: spots[i % spots.length].x,
    y: spots[i % spots.length].y,
    flipX: false,
    state: 'WANDER', // WANDER, INVESTIGATE, CHASE, SEARCH
    targetId: null,
    goal: null,
    path: [],
    repathAt: 0,
    lastSeen: null,
    chaseStart: 0,
    heardAt: now,
    smelledAt: now,
    sniffAt: now,
    frozen: false,
    stunnedUntil: 0,
    lookUntil: 0,
    pauseUntil: now + C.START_DELAY
  }));
}

// Standing survivors who are connected; a dropped player's held seat doesn't count
const isActive = (p) => p.role === 'SURVIVOR' && !p.isEscaped && !p.isDowned && !p.isDead && !p.away;

// Players Cobb can go after: standing, and not sheltering in the furnace's light
const isPrey = (room, p) => isActive(p) && !inSafeZone(room, p);

// Lights that are part of the room: the fire, and lamps whose breaker is on
function inRoomLight(room, p, shrink = 1) {
  const f = room.mapData.furnace;
  if (dist(p, f) < CONSTANTS.furnaceRadius(f.fuel) * shrink) return true;
  return room.mapData.breakers.some(b => b.active &&
    b.lamps.some(l => dist(p, l) < CONSTANTS.LIGHTS.BRAZIER_RADIUS * shrink));
}

// COBB CAN SEE: a full lantern shows down any open line, a shuttered one only up close.
// Standing in a lit room gives you away either way.
function canSee(cobb, room, p) {
  const range = !p.lanternDim || inRoomLight(room, p, 0.8) ? C.VISION_RANGE : C.SHUTTERED_VISION;
  return dist(cobb, p) <= range && lineOfSight(room.mapData.grid, cobb, p);
}

// COBB CAN'T MOVE: frozen while a standing player's lantern faces it. Only people count:
// a lamp would pin Cobb in its room for the whole level.
function isWatched(cobb, room) {
  for (const p of room.players.values()) {
    if (!isActive(p)) continue;
    const radius = p.lanternDim ? CONSTANTS.LIGHTS.LANTERN_STEALTH : CONSTANTS.LIGHTS.LANTERN_RADIUS;
    const facing = p.flipX ? -1 : 1;
    if (dist(cobb, p) <= radius * 0.9 && (cobb.x - p.x) * facing >= -8 && lineOfSight(room.mapData.grid, p, cobb)) {
      return true;
    }
  }
  return false;
}

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
  // Stay out of the furnace hub (room 0) while wandering
  const choices = room.mapData.rooms.filter(r => r.id !== 0 && r !== here);
  const r = choices[Math.floor(Math.random() * choices.length)];
  setGoal(cobb, room.walk, { x: tileCenter(r.centerX), y: tileCenter(r.centerY) });
}

function startChase(cobb, p, now) {
  cobb.state = 'CHASE';
  cobb.targetId = p.id;
  cobb.repathAt = 0;
  cobb.chaseStart = now;
  cobb.lookUntil = 0;
}

function investigate(cobb, room, spot) {
  if (setGoal(cobb, room.walk, spot)) {
    cobb.state = 'INVESTIGATE';
    cobb.lookUntil = 0;
  }
}

// TETHERED: farther than the tether from every other standing teammate
function isStraying(room, p) {
  for (const q of room.players.values()) {
    if (q !== p && isActive(q) && dist(p, q) <= CONSTANTS.TWISTS.TETHER_RANGE) return false;
  }
  return true;
}

// Senses, strongest first: someone right there, someone seen (or straying), a noise, a scent
function perceive(cobb, room, now) {
  const cfg = room.cfg;
  let best = null;
  room.players.forEach((p) => {
    if (!isPrey(room, p)) return;
    const d = dist(cobb, p);
    const noticed = d <= C.AGGRO_RADIUS || (cfg.see && canSee(cobb, room, p)) || (cfg.tethered && isStraying(room, p));
    if (noticed && (!best || d < best.d)) best = { p, d };
  });
  if (best) {
    startChase(cobb, best.p, now);
    return;
  }

  if (cfg.hear) {
    const heard = room.noises.filter(n => n.t > cobb.heardAt && dist(cobb, n) <= n.radius).pop();
    if (heard) {
      cobb.heardAt = heard.t;
      investigate(cobb, room, heard);
      return;
    }
  }

  if (cfg.smell && now >= cobb.sniffAt) {
    cobb.sniffAt = now + C.SNIFF_INTERVAL;
    let freshest = null;
    room.players.forEach((p) => {
      if (!isPrey(room, p)) return;
      p.trail.forEach((c) => {
        if (c.t > cobb.smelledAt && dist(cobb, c) <= C.SMELL_RANGE && (!freshest || c.t > freshest.t)) freshest = c;
      });
    });
    if (freshest) {
      cobb.smelledAt = freshest.t;
      investigate(cobb, room, freshest);
    }
  }
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
// pauseUntil makes Cobb fully inert (round start, after a grab, stunned by a rock);
// lookUntil only stops it walking while it searches.
function stepCobb(cobb, room, dt, now) {
  if (now < cobb.pauseUntil) return null;
  const cfg = room.cfg;
  const players = room.players;

  // VERSUS: a player steers this Cobb; the server only freezes it and checks its grabs
  if (cobb.controlledBy) {
    cobb.frozen = cfg.cantMove && isWatched(cobb, room);
    return cobb.frozen ? null : grabCheck(cobb, room, now);
  }

  if (cobb.state !== 'CHASE') perceive(cobb, room, now);

  let speed = C.WANDER_SPEED;
  if (cobb.state === 'INVESTIGATE') speed = C.INVESTIGATE_SPEED;
  if (cobb.state === 'CHASE') {
    const target = players.get(cobb.targetId);
    const d = target ? dist(cobb, target) : Infinity;
    // SEE keeps a chase going down a long corridor; TETHERED keeps it on a straggler anywhere
    const stillSeen = target && ((cfg.see && canSee(cobb, room, target)) || (cfg.tethered && isStraying(room, target)));
    if (!target || !isActive(target) || (d > C.LOSE_RADIUS && !stillSeen)) {
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
      if (cfg.accel) speed *= 1 + Math.min(C.CHASE_ACCEL_MAX, ((now - cobb.chaseStart) / 1000) * C.CHASE_ACCEL);
      cobb.lastSeen = { x: target.x, y: target.y };
      if (now >= cobb.repathAt) {
        cobb.repathAt = now + C.REPATH_INTERVAL;
        if (!setGoal(cobb, room.walk, target)) cobb.state = 'WANDER';
      } else if (cobb.goal) {
        cobb.goal = { x: target.x, y: target.y };
      }
    }
  }
  speed *= cfg.speedMul;

  cobb.frozen = cfg.cantMove && isWatched(cobb, room);
  if (cfg.cantMove && !cobb.frozen) speed *= C.UNWATCHED_MUL;

  // Looking around (or being watched) stops Cobb's feet, not its senses
  if (cobb.state === 'CHASE') cobb.lookUntil = 0;
  if (!cobb.frozen && now >= cobb.lookUntil) {
    if (cobb.state === 'WANDER' && !cobb.goal) pickWanderRoom(cobb, room);

    const arrived = moveAlong(cobb, speed, dt);
    if (arrived && (cobb.state === 'SEARCH' || cobb.state === 'INVESTIGATE')) {
      cobb.state = 'WANDER';
      cobb.goal = null;
      cobb.lookUntil = now + C.SEARCH_PAUSE;
    } else if (arrived && cobb.state === 'WANDER') {
      cobb.goal = null;
    }
  }

  // A frozen Cobb can't lift its arms either
  return cobb.frozen ? null : grabCheck(cobb, room, now);
}

function grabCheck(cobb, room, now) {
  for (const p of room.players.values()) {
    if (isPrey(room, p) && now >= (p.safeUntil || 0) && dist(cobb, p) <= room.cfg.reach) {
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

// Duplicates push apart instead of stacking into one sprite
function separate(cobbs, walk) {
  for (let i = 0; i < cobbs.length; i++) {
    for (let j = i + 1; j < cobbs.length; j++) {
      const a = cobbs[i];
      const b = cobbs[j];
      const d = dist(a, b);
      if (d >= C.SEPARATION) continue;
      const nx = d > 0.01 ? (a.x - b.x) / d : 1;
      const ny = d > 0.01 ? (a.y - b.y) / d : 0;
      const push = (C.SEPARATION - d) / 2;
      [[a, 1], [b, -1]].forEach(([c, s]) => {
        if (c.controlledBy) return; // a player's Cobb goes where they steer it
        const x = c.x + nx * push * s;
        const y = c.y + ny * push * s;
        if (walk[toTile(y)][toTile(x)] === OPEN) {
          c.x = x;
          c.y = y;
        }
      });
    }
  }
}

// Stun from a rock: stops Cobb in its tracks and makes it forget who it was after
function stun(cobb, now) {
  cobb.pauseUntil = now + C.ROCK_STUN;
  cobb.stunnedUntil = now + C.ROCK_STUN;
  cobb.state = 'WANDER';
  cobb.targetId = null;
  cobb.goal = null;
  cobb.path = [];
}

module.exports = {
  buildWalkGrid, findPath, lineOfSight, createCobbs, stepCobb, separate, stun,
  isActive, inRoomLight, inSafeZone, LIT, OPEN, BLOCKED, toTile
};
