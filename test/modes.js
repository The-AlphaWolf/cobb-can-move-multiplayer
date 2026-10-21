// Checks for the multiplayer modes and co-op twists: Versus, Race, TETHERED, HOT COAL,
// SHARED HEARTBEAT, MIMIC and coal scaling. No sockets.
// Run with: npm test
const assert = require('assert');
const RoomManager = require('../server/RoomManager');
const { stepCobb } = require('../server/cobb');
const { tickRoom, roundResult, throwRock } = require('../server/game');
const { rollRules, ruleConfig } = require('../shared/rules');
const CONSTANTS = require('../shared/constants');

const at = (tx, ty) => ({ x: tx * 32 + 16, y: ty * 32 + 16 });
const NOW = Date.now() + 60000;

function room(mode, count, rules) {
  const rm = new RoomManager();
  const r = rm.createRoom('p0', { mode });
  for (let i = 0; i < count; i++) rm.addPlayer(r.code, `p${i}`, { name: `P${i}` });
  rm.startRound(r);
  if (rules) {
    r.activeRules = rules;
    r.cfg = ruleConfig(rules, 3);
  }
  r.cobbs.forEach(c => { c.pauseUntil = 0; });
  return { rm, r, ps: Array.from(r.players.values()) };
}

// 1. Co-op twists roll only for co-op teams of two or more
for (let i = 0; i < 300; i++) {
  const twists = ['TETHERED', 'HOT_COAL', 'SHARED_HEARTBEAT', 'MIMIC'];
  assert(!rollRules(5, Math.random, { mode: 'coop', players: 1 }).some(r => twists.includes(r)), 'twist rolled solo');
  assert(!rollRules(5, Math.random, { mode: 'versus', players: 4 }).some(r => twists.includes(r)), 'twist rolled in versus');
}
assert([...Array(400)].some(() => rollRules(5, Math.random, { mode: 'coop', players: 3 }).includes('MIMIC')), 'twists never roll');

// 2. Coal needed grows with the team
assert.strictEqual(room('coop', 1).r.mapData.furnace.coalRequired, 4);
assert.strictEqual(room('coop', 3).r.mapData.furnace.coalRequired, 6);

// 3. Versus: one player is Cobb, steering it; the role rotates each round; Cobb still grabs
{
  const { rm, r, ps } = room('versus', 3, ['MOVE']);
  const hunters = ps.filter(p => p.role === 'COBB');
  assert.strictEqual(hunters.length, 1);
  const cobb = r.cobbs[0];
  assert.strictEqual(cobb.controlledBy, hunters[0].id);
  assert.strictEqual(r.mapData.furnace.coalRequired, 5, 'coal scales with survivors only');

  const prey = ps.find(p => p.role === 'SURVIVOR');
  Object.assign(cobb, at(5, 6));
  Object.assign(prey, { x: cobb.x + 200, y: cobb.y });
  const x = cobb.x;
  assert.strictEqual(stepCobb(cobb, r, 0.1, NOW), null);
  assert.strictEqual(cobb.x, x, 'the AI must not move a player-controlled Cobb');
  Object.assign(prey, { x: cobb.x + 10, y: cobb.y });
  assert.strictEqual(stepCobb(cobb, r, 0.1, NOW), prey, 'a player-controlled Cobb still grabs');

  const first = hunters[0].id;
  rm.endRound(r, false);
  rm.startRound(r);
  assert.notStrictEqual(ps.find(p => p.role === 'COBB').id, first, 'Cobb role should rotate');

  // Survivors all caught: survivors lose, and the Cobb player is listed as Cobb
  ps.filter(p => p.role === 'SURVIVOR').forEach(p => { p.isDead = true; });
  const result = roundResult(r);
  assert(!result.won && result.players.some(p => p.status === 'cobb'));
}

// 4. Race: rocks stun rivals and knock their coal loose; the first escape ends the round
{
  const { r, ps } = room('race', 2, ['MOVE']);
  r.cobbs = [];
  const [thrower, rival] = ps;
  Object.assign(thrower, at(5, 4), { rocks: 1 });
  Object.assign(rival, at(8, 4), { hasCoal: true, coalId: 'coal_0' });
  r.mapData.coal[0].collected = true;
  const events = throwRock(r, thrower, at(11, 4), NOW);
  assert(events.some(e => e[0] === 'player:stunned' && e[1].id === rival.id));
  assert(events.some(e => e[0] === 'coal:dropped'));
  assert(rival.stunnedUntil > NOW && !rival.hasCoal);
  assert.strictEqual(r.mapData.furnace.coalRequired, CONSTANTS.RACE.QUOTA);

  assert.strictEqual(roundResult(r), null);
  thrower.isEscaped = true;
  r.raceWinner = thrower.id;
  const result = roundResult(r);
  assert(result && result.winnerId === thrower.id);
}

// 5. TETHERED: a straggler is hunted from anywhere
{
  const { r, ps } = room('coop', 2, ['MOVE', 'TETHERED']);
  const cobb = r.cobbs[0];
  Object.assign(cobb, at(5, 6));
  Object.assign(ps[0], at(40, 30));
  Object.assign(ps[1], at(5, 30)); // far from Cobb and from ps[0]
  stepCobb(cobb, r, 0.05, NOW);
  assert.strictEqual(cobb.state, 'CHASE');
  const s2 = room('coop', 2, ['MOVE', 'TETHERED']);
  Object.assign(s2.r.cobbs[0], at(5, 6));
  Object.assign(s2.ps[0], at(5, 30));
  Object.assign(s2.ps[1], { x: s2.ps[0].x + 100, y: s2.ps[0].y });
  stepCobb(s2.r.cobbs[0], s2.r, 0.05, NOW);
  assert.notStrictEqual(s2.r.cobbs[0].state, 'CHASE', 'a pair should not be hunted');
}

// 6. HOT COAL: held too long, it drops
{
  const { r, ps } = room('coop', 2, ['MOVE', 'HOT_COAL']);
  r.cobbs = [];
  const p = ps[0];
  Object.assign(p, { hasCoal: true, coalId: 'coal_1', coalSince: NOW - CONSTANTS.TWISTS.HOT_COAL_TIME - 1 });
  r.mapData.coal[1].collected = true;
  const events = tickRoom(r, 50, NOW);
  assert(events.some(e => e[0] === 'coal:dropped') && !p.hasCoal);
}

// 7. SHARED HEARTBEAT: one death downs everyone still standing
{
  const { r, ps } = room('coop', 3, ['MOVE', 'SHARED_HEARTBEAT']);
  r.cobbs = [];
  ps.forEach(p => Object.assign(p, at(5, 6)));
  Object.assign(ps[0], { isDowned: true, bleedLeft: 10 });
  ps[1].x += 300; // nobody close enough to revive
  ps[2].x += 300;
  const events = tickRoom(r, 50, NOW);
  assert(events.some(e => e[0] === 'player:died'));
  assert(ps[1].isDowned && ps[2].isDowned);
  assert(roundResult(r) && roundResult(r).tip, 'a wiped team loses, with a tip');
}

// 8. MIMIC: every Cobb borrows a survivor's face
{
  const { r, rm } = room('coop', 3);
  r.rulesLevel = r.level; // keep forced rules
  r.activeRules = ['MOVE', 'MIMIC'];
  rm.startRound(r);
  assert(r.cobbs.every(c => r.players.has(c.mimicId)));
}

console.log('PASS modes');
