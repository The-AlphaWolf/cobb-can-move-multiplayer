// Per-tick round rules: Cobb grabs, downed players, revives and bleed-outs.
// Returns socket events as [name, data] pairs so it stays testable without sockets.
const CONSTANTS = require('../shared/constants');
const { stepCobb, isActive, buildWalkGrid } = require('./cobb');

const P = CONSTANTS.PLAYER;
const REVIVE_SLACK = 24; // latency allowance on top of REVIVE_RADIUS

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

function tickRoom(room, dtMs, now) {
  const events = [];
  burnFuel(room, dtMs);

  room.cobbs.forEach((cobb) => {
    const victim = stepCobb(cobb, room, dtMs / 1000, now);
    if (!victim) return;
    victim.isDowned = true;
    victim.bleedLeft = P.BLEEDOUT_TIME;
    victim.reviveProgress = 0;
    victim.reviving = false;
    const drop = dropCoal(room, victim);
    if (drop) events.push(drop);
    events.push(['player:downed', { id: victim.id, by: cobb.id }]);
  });

  const players = Array.from(room.players.values());
  players.filter(p => p.isDowned).forEach((p) => {
    const reviver = players.find(r => r.reviving && isActive(r) && dist(r, p) <= P.REVIVE_RADIUS + REVIVE_SLACK);
    if (reviver) {
      // The bleed-out clock pauses while someone is helping
      p.reviveProgress += dtMs;
      if (p.reviveProgress >= P.REVIVE_TIME) {
        p.isDowned = false;
        p.reviveProgress = 0;
        p.safeUntil = now + P.REVIVE_GRACE;
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

  return events;
}

// What every client needs each tick: where the Cobbs are and how the downed are doing
function snapshot(room) {
  return {
    fuel: Math.round(room.mapData.furnace.fuel),
    cobbs: room.cobbs.map(c => ({
      id: c.id,
      x: Math.round(c.x),
      y: Math.round(c.y),
      flipX: c.flipX,
      state: c.state,
      targetId: c.targetId
    })),
    downed: Array.from(room.players.values())
      .filter(p => p.isDowned)
      .map(p => ({ id: p.id, bleedLeft: Math.max(0, Math.round(p.bleedLeft)), progress: p.reviveProgress / P.REVIVE_TIME }))
  };
}

// The round ends once nobody is left standing. Downed players count as lost then,
// since no one can revive them.
function roundResult(room) {
  const survivors = Array.from(room.players.values()).filter(p => p.role === 'SURVIVOR');
  if (survivors.some(isActive)) return null;
  const won = survivors.some(p => p.isEscaped);
  const rule = room.activeRules[room.activeRules.length - 1];
  return {
    won,
    level: room.level,
    tip: won ? null : CONSTANTS.RULE_TIPS[rule] || null,
    durationMs: Date.now() - room.stats.startTime,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.isEscaped ? 'escaped' : 'caught'
    }))
  };
}

module.exports = { tickRoom, snapshot, roundResult, dropCoal };
