// Level rules: what changes about Cobb (and you) on each level.
// Loaded by the server (require) and the browser (window.RULESET).
(function (root) {
  const CONSTANTS = typeof module !== 'undefined' && module.exports ? require('./constants') : root.CONSTANTS;

  const RULES = {
    MOVE: {
      title: 'COBB CAN MOVE',
      desc: 'Find coal and feed the furnace. Cobb will not enter its light, but the fire burns down.',
      tip: 'Cobb only notices you up close. Keep your distance, and walk away the moment it turns toward you.'
    },
    SEE: {
      title: 'COBB CAN SEE',
      desc: 'Cobb spots lanterns down open lines of sight. Press F to shutter yours.',
      tip: 'Break line of sight at corners and shutter your lantern (F) in the dark. Lit rooms give you away.'
    },
    HEAR: {
      title: 'COBB CAN HEAR',
      desc: 'Sprinting, coal, breakers and rocks make noise, and Cobb comes to look.',
      tip: 'Walk near Cobb instead of sprinting. Throw a rock (click) away from your route to pull it off you.'
    },
    SMELL: {
      title: 'COBB CAN SMELL',
      desc: 'Cobb follows the trail you leave behind.',
      tip: 'Do not double back. Loop through fresh ground and finish at the fire.'
    },
    REACH: {
      title: 'COBB CAN REACH',
      desc: 'Cobb grabs from much farther away than it looks.',
      tip: 'Take corners wide and never squeeze past Cobb in a doorway.'
    },
    FASTER: {
      title: 'COBB CAN BE FASTER',
      desc: 'Cobb outpaces walking, and speeds up the longer it chases.',
      tip: 'Save stamina for the chase, and stun Cobb with a rock (click) when it closes in.'
    },
    DUPLICATE: {
      title: 'COBB CAN DUPLICATE',
      desc: 'There is more than one Cobb.',
      tip: 'Keep trips short and check rooms before crossing them. A clear room is not a safe one.'
    },
    // This remake's twist: a weeping-angel Cobb that punishes a team that splits its attention
    CANT_MOVE: {
      title: "COBB CAN'T MOVE",
      desc: 'Cobb freezes while someone faces it with their lantern. Look away and it rushes you.',
      tip: "Cover each other's backs. Someone keeps their light on Cobb while the others work."
    },
    FREEZE: {
      title: 'FREEZE',
      debuff: true,
      desc: 'The cold kills. Stay near the fire or a lit lamp to keep warm.',
      tip: 'Plan routes between heat: the fire and rooms with their lamps on. Flip breakers early.'
    },
    STARVE: {
      title: 'STARVE',
      debuff: true,
      desc: 'You are starving. Eat carrots (E); they grow back.',
      tip: 'Fold carrot spots into your coal runs, and share the route with your team.'
    }
  };

  const SENSES = ['SEE', 'HEAR', 'SMELL'];
  const POOL = ['SEE', 'HEAR', 'SMELL', 'REACH', 'FASTER', 'DUPLICATE', 'CANT_MOVE'];
  const DEBUFFS = ['FREEZE', 'STARVE'];
  const STORY_LEVELS = 7;

  // Level 1 eases you in, level 2 always adds a sense, 3-6 roll from the pool (debuffs from 4),
  // and 7 onwards (the finale, then endless) stacks two rules plus a debuff.
  function rollRules(level, rand = Math.random) {
    const pick = (list, taken) => {
      const choices = list.filter(r => !taken.includes(r));
      return choices[Math.floor(rand() * choices.length)];
    };
    const rules = ['MOVE'];
    if (level <= 1) return rules;
    if (level === 2) return [...rules, pick(SENSES, rules)];
    rules.push(pick(POOL, rules));
    if (level >= STORY_LEVELS) rules.push(pick(POOL, rules));
    if (level >= STORY_LEVELS || (level >= 4 && rand() < 0.5)) rules.push(pick(DEBUFFS, rules));
    return rules;
  }

  // Turn a rule list into the numbers the simulation uses
  function ruleConfig(rules, level) {
    const C = CONSTANTS.COBB;
    const has = r => rules.includes(r);
    return {
      see: has('SEE'),
      hear: has('HEAR'),
      smell: has('SMELL'),
      reach: has('REACH') ? C.LONG_REACH : C.NORMAL_REACH,
      speedMul: has('FASTER') ? C.FASTER_MUL : 1,
      accel: has('FASTER'),
      cobbCount: has('DUPLICATE') ? (level >= 6 ? 3 : 2) : 1,
      cantMove: has('CANT_MOVE'),
      freeze: has('FREEZE'),
      starve: has('STARVE')
    };
  }

  // The newest non-debuff rule is the level's headline; its tip is the one worth showing
  const headline = rules => rules.filter(r => !RULES[r].debuff).pop();

  const api = { RULES, STORY_LEVELS, rollRules, ruleConfig, headline };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RULESET = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
