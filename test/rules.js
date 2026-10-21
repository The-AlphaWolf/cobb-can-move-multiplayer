// Checks for the level rules: rule rolling, Cobb's senses, reach, duplicates,
// the COBB CAN'T MOVE twist, cold and hunger, and rocks. No sockets.
// Run with: npm test
const assert = require('assert');
const RoomManager = require('../server/RoomManager');
const { createCobbs, stepCobb, separate } = require('../server/cobb');
const { tickRoom, roundResult, makeNoise, throwRock } = require('../server/game');
const { rollRules, ruleConfig, RULES, STORY_LEVELS } = require('../shared/rules');
const CONSTANTS = require('../shared/constants');

const at = (tx, ty) => ({ x: tx * 32 + 16, y: ty * 32 + 16 });
const NOW = Date.now() + 60000;

// A started room with the given rules, one Cobb parked at tile (5,6) of the top-left wing
// and every player out of the way unless a test moves them
function setup(rules, level = 3) {
  const rm = new RoomManager();
  const room = rm.createRoom('a');
  rm.addPlayer(room.code, 'a', { name: 'A' });
  rm.addPlayer(room.code, 'b', { name: 'B' });
  rm.startRound(room);
  room.activeRules = rules;
  room.cfg = ruleConfig(rules, level);
  room.cobbs = createCobbs(room.mapData, NOW, room.cfg.cobbCount);
  room.cobbs.forEach(c => Object.assign(c, { pauseUntil: 0 }));
  Object.assign(room.cobbs[0], at(5, 6));
  const a = room.players.get('a');
  const b = room.players.get('b');
  Object.assign(a, at(40, 30));
  Object.assign(b, at(40, 30));
  b.isDead = true; // only A is in play unless a test says otherwise
  return { room, a, b, cobb: room.cobbs[0] };
}

// 1. Rule rolling follows the level ladder and never repeats a rule
for (let i = 0; i < 300; i++) {
  assert.deepStrictEqual(rollRules(1), ['MOVE']);
  const l2 = rollRules(2);
  assert(l2.length === 2 && ['SEE', 'HEAR', 'SMELL'].includes(l2[1]));
  for (let level = 3; level <= 9; level++) {
    const rules = rollRules(level);
    assert.strictEqual(new Set(rules).size, rules.length, 'repeated rule');
    assert(rules.every(r => RULES[r]), 'unknown rule');
    if (level < 4) assert.strictEqual(rules.filter(r => RULES[r].debuff).length, 0, 'debuff before level 4');
    if (level >= STORY_LEVELS) assert.strictEqual(rules.length, 4, 'finale stacks two rules and a debuff');
  }
}

// 2. COBB CAN SEE: a full lantern is spotted across a room, a shuttered one is not, walls block sight
{
  const { room, a, cobb } = setup(['MOVE', 'SEE']);
  Object.assign(a, at(11, 6)); // same room, 192 px away
  stepCobb(cobb, room, 0.05, NOW);
  assert.strictEqual(cobb.state, 'CHASE', 'should see a full lantern');

  const s2 = setup(['MOVE', 'SEE']);
  Object.assign(s2.a, at(11, 6), { lanternDim: true });
  stepCobb(s2.cobb, s2.room, 0.05, NOW);
  assert.notStrictEqual(s2.cobb.state, 'CHASE', 'should not see a shuttered lantern in the dark');

  const s3 = setup(['MOVE', 'SEE']);
  Object.assign(s3.cobb, at(11, 9));
  Object.assign(s3.a, at(16, 12)); // in the hub, behind the wing's wall
  stepCobb(s3.cobb, s3.room, 0.05, NOW);
  assert.notStrictEqual(s3.cobb.state, 'CHASE', 'walls should block sight');

  const s4 = setup(['MOVE']);
  Object.assign(s4.a, at(11, 6));
  stepCobb(s4.cobb, s4.room, 0.05, NOW);
  assert.notStrictEqual(s4.cobb.state, 'CHASE', 'without SEE, distance alone should not trigger a chase');
}

// 3. COBB CAN HEAR: walks to a noise in earshot; without HEAR noises are ignored
{
  const { room, cobb } = setup(['MOVE', 'HEAR']);
  const spot = at(10, 8);
  assert(makeNoise(room, spot.x, spot.y, 200, NOW + 1));
  stepCobb(cobb, room, 0.05, NOW + 2);
  assert.strictEqual(cobb.state, 'INVESTIGATE');
  assert.deepStrictEqual(cobb.goal, { x: spot.x, y: spot.y });

  const quiet = setup(['MOVE']);
  assert.strictEqual(makeNoise(quiet.room, spot.x, spot.y, 200, NOW + 1), null);
}

// 4. COBB CAN SMELL: follows a fresh crumb of your trail
{
  const { room, a, cobb } = setup(['MOVE', 'SMELL']);
  const crumb = { ...at(9, 8), t: NOW + 1 };
  a.trail.push(crumb);
  cobb.sniffAt = 0;
  stepCobb(cobb, room, 0.05, NOW + 2);
  assert.strictEqual(cobb.state, 'INVESTIGATE');
  assert.strictEqual(cobb.goal.x, crumb.x);
}

// 5. COBB CAN REACH grabs from farther away
{
  const { room, a, cobb } = setup(['MOVE', 'REACH']);
  Object.assign(a, { x: cobb.x + 50, y: cobb.y });
  cobb.pauseUntil = 0;
  assert.strictEqual(stepCobb(cobb, room, 0.001, NOW), a);
  const normal = setup(['MOVE']);
  Object.assign(normal.a, { x: normal.cobb.x + 50, y: normal.cobb.y });
  assert.strictEqual(stepCobb(normal.cobb, normal.room, 0.001, NOW), null);
}

// 6. COBB CAN DUPLICATE: several Cobbs, in different places, that don't stack
{
  const { room } = setup(['MOVE', 'DUPLICATE'], 6);
  assert.strictEqual(room.cobbs.length, 3);
  assert.strictEqual(new Set(room.cobbs.map(c => `${c.x},${c.y}`)).size, 3);
  Object.assign(room.cobbs[1], { x: room.cobbs[0].x + 2, y: room.cobbs[0].y });
  separate(room.cobbs, room.walk);
  assert(Math.hypot(room.cobbs[0].x - room.cobbs[1].x, room.cobbs[0].y - room.cobbs[1].y) > 20);
}

// 7. COBB CAN'T MOVE (this remake's twist): frozen and harmless while a lantern faces it
{
  const { room, a, cobb } = setup(['MOVE', 'CANT_MOVE']);
  Object.assign(a, { x: cobb.x - 20, y: cobb.y, flipX: false }); // facing right, at Cobb
  const sx = cobb.x;
  assert.strictEqual(stepCobb(cobb, room, 0.05, NOW), null, 'a watched Cobb must not grab');
  assert(cobb.frozen && cobb.x === sx, 'a watched Cobb must not move');
  a.flipX = true; // looks away
  assert.strictEqual(stepCobb(cobb, room, 0.05, NOW + 50), a, 'look away and it gets you');

  // Lamps don't count, or flipping a breaker would pin Cobb in its room all level
  const lamp = setup(['MOVE', 'CANT_MOVE']);
  const breaker = lamp.room.mapData.breakers[0];
  breaker.active = true;
  Object.assign(lamp.cobb, breaker.lamps[0]);
  stepCobb(lamp.cobb, lamp.room, 0.05, NOW);
  assert(!lamp.cobb.frozen, 'a lamp must not freeze Cobb');
}

// 8. FREEZE: the cold downs you in the dark and the results blame the cold
{
  const { room, a } = setup(['MOVE', 'HEAR', 'FREEZE']);
  Object.assign(a, at(5, 9), { warmth: 1 });
  room.cobbs = [];
  const events = tickRoom(room, 1000, NOW);
  assert(events.some(e => e[0] === 'player:downed' && e[1].cause === 'FREEZE'));
  const result = roundResult(room);
  assert.strictEqual(result.tip, RULES.FREEZE.tip);

  // ...and the fire warms you back up
  const warmRoom = setup(['MOVE', 'FREEZE']);
  Object.assign(warmRoom.a, { x: warmRoom.room.mapData.furnace.x + 60, y: warmRoom.room.mapData.furnace.y, warmth: 50 });
  warmRoom.room.cobbs = [];
  tickRoom(warmRoom.room, 1000, NOW);
  assert(warmRoom.a.warmth > 50);
}

// 9. STARVE: hunger only drops under the rule
{
  const { room, a } = setup(['MOVE', 'STARVE']);
  room.cobbs = [];
  tickRoom(room, 2000, NOW);
  assert(a.hunger < CONSTANTS.PLAYER.HUNGER_MAX);
  const fed = setup(['MOVE']);
  fed.room.cobbs = [];
  tickRoom(fed.room, 2000, NOW);
  assert.strictEqual(fed.a.hunger, CONSTANTS.PLAYER.HUNGER_MAX);
}

// 10. Rocks stun a Cobb in their path and land back on the floor
{
  const { room, a, cobb } = setup(['MOVE']);
  Object.assign(a, at(5, 4), { rocks: 1 });
  Object.assign(cobb, at(9, 4));
  const before = room.mapData.rocks.length;
  const events = throwRock(room, a, at(11, 4), NOW);
  const thrown = events.find(e => e[0] === 'rock:thrown')[1];
  assert.strictEqual(thrown.hitCobb, cobb.id);
  assert(cobb.pauseUntil > NOW && cobb.stunnedUntil > NOW);
  assert.strictEqual(a.rocks, 0);
  assert.strictEqual(room.mapData.rocks.length, before + 1);
}

console.log('PASS rules');
