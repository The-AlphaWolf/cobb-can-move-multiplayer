// Per-tick round rules: Cobb grabs, downed players, revives, bleed-outs, cold, hunger,
// noise, scent and rocks. Returns socket events as [name, data] pairs so it stays
// testable without sockets.
const CONSTANTS = require('../shared/constants');
const { RULES, headline, STORY_LEVELS } = require('../shared/rules');
const { stepCobb, separate, stun, isActive, inRoomLight, buildWalkGrid, toTile } = require('./cobb');

const P = CONSTANTS.PLAYER;
const REVIVE_SLACK = 24; // latency allowance on top of REVIVE_RADIUS
const ROCK_HIT_RADIUS = 22;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Put carried coal back on the floor under the player, so it can't be lost for good
function dropCoal(room, player) {
  if (!player.hasCoal) return null;
  const coal = room.mapData.coal.find(c => c.id === player.coalId);
  player.hasCoal = false;
  player.coalId = null;
  if (!coal) return null;
  coal.collected = false;
  coal.x = Math.round(player.x);
  coal.y = Math.round(player.y);
  return ['coal:dropped', { coalId: coal.id, x: coal.x, y: coal.y, droppedBy: player.id }];
}

// cause: 'COBB', 'FREEZE' or 'STARVE'; remembered so a lost round shows the right tip
function downPlayer(room, p, cause, events) {
  p.isDowned = true;
  p.bleedLeft = P.BLEEDOUT_TIME;
  p.reviveProgress = 0;
  p.reviving = false;
  room.lastDownCause = cause;
  const drop = dropCoal(room, p);
  if (drop) events.push(drop);
  events.push(['player:downed', { id: p.id, cause }]);
}

// A sound Cobb may hear (COBB CAN HEAR). Returns the event that shows players the ripple.
function makeNoise(room, x, y, radius, now = Date.now()) {
  if (!room.cfg.hear) return null;
  room.noises.push({ x, y, radius, t: now });
  return ['noise', { x: Math.round(x), y: Math.round(y), radius }];
}

// Scent breadcrumbs (COBB CAN SMELL), dropped as the player moves
function recordTrail(p, now) {
  if (now - (p.trailAt || 0) < CONSTANTS.TRAIL.INTERVAL) return;
  p.trailAt = now;
  p.trail.push({ x: p.x, y: p.y, t: now });
  if (p.trail.length > CONSTANTS.TRAIL.MAX) p.trail.shift();
}

// A thrown rock flies toward the target until it hits a wall, a Cobb or its range.
// It lands as a new rock on the floor and makes a noise there.
function throwRock(room, p, target, now) {
  const events = [];
  const d = dist(p, target);
  if (d < 1) return events;
  const dx = (target.x - p.x) / d;
  const dy = (target.y - p.y) / d;
  const range = Math.min(d, P.ROCK_RANGE);
  let land = { x: p.x, y: p.y };
  let hit = null;
  for (let s = 8; s <= range && !hit; s += 8) {
    const pt = { x: p.x + dx * s, y: p.y + dy * s };
    if (room.mapData.grid[toTile(pt.y)][toTile(pt.x)] !== CONSTANTS.TILE_TYPES.FLOOR) break;
    land = pt;
    hit = room.cobbs.find(c => dist(c, pt) <= ROCK_HIT_RADIUS) || null;
  }
  if (hit) stun(hit, now);
  p.rocks -= 1;
  const rock = { id: `rock_${room.nextRockId++}`, x: Math.round(land.x), y: Math.round(land.y) };
  room.mapData.rocks.push(rock);
  events.push(['rock:thrown', { by: p.id, from: { x: Math.round(p.x), y: Math.round(p.y) }, rock, hitCobb: hit ? hit.id : null }]);
  const noise = makeNoise(room, land.x, land.y, CONSTANTS.NOISE.ROCK, now);
  if (noise) events.push(noise);
  return events;
}

// The fire burns down; its safe zone shrinks with it. Cobb's walk grid is rebuilt
// only when the zone's edge crosses into a different tile ring.
function burnFuel(room, dtMs) {
  const f = room.mapData.furnace;
  f.fuel = Math.max(0, f.fuel - dtMs);
  const radius = CONSTANTS.safeRadius(f.fuel);
  if (Math.floor(radius / 16) !== Math.floor((room.safeRadius || 0) / 16)) {
    room.walk = buildWalkGrid(room.mapData, radius);
  }
  room.safeRadius = radius;
}

// FREEZE and STARVE: warmth comes back near the fire or a lit lamp; food only from carrots
function updateVitals(room, p, dtMs, events) {
  const dt = dtMs / 1000;
  if (room.cfg.freeze) {
    // Even a dead fire's embers warm whoever huddles right next to them
    const warm = inRoomLight(room, p);
    p.warmth = Math.min(P.WARMTH_MAX, Math.max(0, p.warmth + (warm ? P.WARMTH_REGEN : -P.WARMTH_DRAIN) * dt));
    if (p.warmth <= 0) return downPlayer(room, p, 'FREEZE', events);
  }
  if (room.cfg.starve) {
    p.hunger = Math.max(0, p.hunger - P.HUNGER_DRAIN * dt);
    if (p.hunger <= 0) downPlayer(room, p, 'STARVE', events);
  }
}

function tickRoom(room, dtMs, now) {
  const events = [];
  burnFuel(room, dtMs);
  room.noises = room.noises.filter(n => now - n.t < CONSTANTS.NOISE.LIFE);

  room.cobbs.forEach((cobb) => {
    const victim = stepCobb(cobb, room, dtMs / 1000, now);
    if (victim) downPlayer(room, victim, 'COBB', events);
  });
  separate(room.cobbs, room.walk);

  const players = Array.from(room.players.values());
  players.forEach((p) => {
    p.trail = p.trail.filter(c => now - c.t < CONSTANTS.TRAIL.LIFE);
    if (isActive(p)) updateVitals(room, p, dtMs, events);
  });

  players.filter(p => p.isDowned).forEach((p) => {
    const reviver = players.find(r => r.reviving && isActive(r) && dist(r, p) <= P.REVIVE_RADIUS + REVIVE_SLACK);
    if (reviver) {
      // The bleed-out clock pauses while someone is helping
      p.reviveProgress += dtMs;
      if (p.reviveProgress >= P.REVIVE_TIME) {
        p.isDowned = false;
        p.reviveProgress = 0;
        p.safeUntil = now + P.REVIVE_GRACE;
        p.warmth = Math.max(p.warmth, P.REVIVE_REFILL);
        p.hunger = Math.max(p.hunger, P.REVIVE_REFILL);
        events.push(['player:revived', { id: p.id, by: reviver.id }]);
      }
      return;
    }
    p.reviveProgress = 0;
    p.bleedLeft -= dtMs;
    if (p.bleedLeft <= 0) {
      p.isDowned = false;
      p.isDead = true;
      events.push(['player:died', { id: p.id }]);
    }
  });

  room.mapData.carrots.forEach((c) => {
    if (c.respawnAt && now >= c.respawnAt) {
      c.respawnAt = 0;
      events.push(['carrot:updated', { carrotId: c.id, available: true }]);
    }
  });

  return events;
}

// What every client needs each tick: the Cobbs, the downed, the fire and everyone's vitals
function snapshot(room, now = Date.now()) {
  const players = Array.from(room.players.values());
  return {
    fuel: Math.round(room.mapData.furnace.fuel),
    cobbs: room.cobbs.map(c => ({
      id: c.id,
      x: Math.round(c.x),
      y: Math.round(c.y),
      flipX: c.flipX,
      state: c.state,
      targetId: c.targetId,
      frozen: c.frozen,
      stunned: now < c.stunnedUntil
    })),
    downed: players
      .filter(p => p.isDowned)
      .map(p => ({ id: p.id, bleedLeft: Math.max(0, Math.round(p.bleedLeft)), progress: p.reviveProgress / P.REVIVE_TIME })),
    vitals: room.cfg.freeze || room.cfg.starve
      ? players.map(p => ({ id: p.id, warmth: Math.round(p.warmth), hunger: Math.round(p.hunger) }))
      : undefined
  };
}

// The round ends once nobody is left standing. Downed players count as lost then,
// since no one can revive them.
function roundResult(room) {
  const survivors = Array.from(room.players.values()).filter(p => p.role === 'SURVIVOR');
  if (survivors.some(isActive)) return null;
  const won = survivors.some(p => p.isEscaped);
  const cause = room.lastDownCause === 'FREEZE' || room.lastDownCause === 'STARVE'
    ? room.lastDownCause
    : headline(room.activeRules);
  return {
    won,
    level: room.level,
    storyComplete: won && room.level === STORY_LEVELS,
    tip: won ? null : RULES[cause].tip,
    durationMs: Date.now() - room.stats.startTime,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.isEscaped ? 'escaped' : 'caught'
    }))
  };
}

module.exports = { tickRoom, snapshot, roundResult, dropCoal, makeNoise, recordTrail, throwRock };
