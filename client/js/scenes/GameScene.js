const DOWNED_TINT = 0x995555;
const DEAD_TINT = 0x333333;

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.roomData = data.room;
    this.socket = window.gameSocket;
    this.myId = this.socket.id;
    this.me = this.roomData.players.find(p => p.id === this.myId);
    this.networkSendTimer = 0;
    this.status = 'active'; // active, downed, dead, escaped
    this.reviving = false;
    this.spectating = null;
    this.cfg = this.roomData.cfg; // which rules are on (see shared/rules.js)
    this.rocks = 0;
    this.lanternDim = false;
    this.vitals = { warmth: 100, hunger: 100 };
    this.isCobb = this.me.role === 'COBB'; // VERSUS: this player hunts as Cobb
    this.isRace = this.roomData.mode === 'race';
    this.stunnedUntil = 0;  // RACE: hit by a rival's rock
    this.cobbHeld = false;  // VERSUS: our Cobb is paused, stunned or watched
    this.coalSince = 0;     // HOT COAL
  }

  create() {
    console.log('[GameScene] Initializing atmospheric horror dungeon...');

    // 1. Map comes from the server so every player shares it
    this.mapData = this.roomData.mapData;

    const ts = window.CONSTANTS.TILE_SIZE;
    const worldW = this.mapData.width * ts;
    const worldH = this.mapData.height * ts;

    // Physics bounds default to the canvas size (960x640); without this the east wing and
    // the exit sit behind an invisible wall
    this.physics.world.setBounds(0, 0, worldW, worldH);

    // 2. Build Dungeon Tilemap (Floors & Walls), lit by Phaser's Light2D
    this.lights.enable().setAmbientColor(window.CONSTANTS.LIGHTS.AMBIENT);
    this.buildDungeon();

    // 3. Create Central Furnace
    this.createFurnace();

    // 4. Create Exit Blast Door
    this.createExitDoor();

    // 5. Spawn Collectibles (Coal, Breakers, Rocks)
    this.createInteractiveObjects();

    // 6. Spawn Local Player
    this.createPlayer();

    // 7. Cobb is simulated on the server; we only draw it
    this.cobbs = new Map();
    this.roomData.cobbs.filter(c => c.controlledBy !== this.myId).forEach(c => this.addCobb(c));

    // 8. Remote Players, placed at their server-assigned spawns
    this.remotePlayers = new Map();
    this.roomData.players
      .filter(p => p.id !== this.myId && !p.isEscaped && p.role !== 'COBB')
      .forEach(p => this.addRemotePlayer(p));

    // 9. Lights: lantern, furnace fire, exit, breaker-powered lamps
    this.createLighting();

    // 10. Camera Setup with Smooth Following
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
    this.cameras.main.setZoom(2.0); // 2x retro pixel zoom for crisp readable sprites
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    // 11. Setup Input Controls
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      interact: Phaser.Input.Keyboard.KeyCodes.E,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      shift: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      map: Phaser.Input.Keyboard.KeyCodes.M,
      lantern: Phaser.Input.Keyboard.KeyCodes.F,
      throw: Phaser.Input.Keyboard.KeyCodes.R,
      mute: Phaser.Input.Keyboard.KeyCodes.N
    });
    this.pad = { x: 0, y: 0, sprint: false, a: false };
    this.padPrev = {};
    this.stepTimer = 0;
    this.beatTimer = 0;
    // Click throws a rock at the pointer
    this.input.on('pointerdown', (pointer) => {
      if (this.status === 'active') this.throwRock(pointer.worldX, pointer.worldY);
    });

    // 12. Setup Network Listeners, then catch up on anything missed while booting
    this.setupNetworkHandlers();
    this.socket.emit('game:sync', {}, (res) => {
      if (res && res.room && this.player.active) this.applySnapshot(res.room);
    });

    // 13. Initialize Real-Time Facility Minimap Radar
    this.initMinimap();

    // 14. Announce this level's rules
    this.announceRules();

    // 15. Initial HUD Update
    this.updateHUD();
  }

  // One tilemap layer: grid values double as tile indices (1 floor, 2 wall)
  buildDungeon() {
    const ts = window.CONSTANTS.TILE_SIZE;
    const map = this.make.tilemap({ data: this.mapData.grid, tileWidth: ts, tileHeight: ts });
    const tiles = map.addTilesetImage('tileset', 'tileset', ts, ts, 0, 0);
    this.layer = map.createLayer(0, tiles, 0, 0).setPipeline('Light2D');
    this.layer.setCollision(window.CONSTANTS.TILE_TYPES.WALL);
  }

  createFurnace() {
    const f = this.mapData.furnace;
    this.furnaceSprite = this.add.image(f.x, f.y, 'furnace_sprite').setPipeline('Light2D');
    this.physics.add.existing(this.furnaceSprite, true);
  }

  createExitDoor() {
    const e = this.mapData.exit;
    this.exitDoorSprite = this.add.image(e.x, e.y, 'exit_door').setPipeline('Light2D');
    this.physics.add.existing(this.exitDoorSprite, true);
  }

  createInteractiveObjects() {
    this.coalGroup = this.physics.add.staticGroup();
    this.coalMap = new Map();

    this.mapData.coal.forEach(c => this.placeCoal(c));

    this.breakerSprites = new Map();
    this.mapData.breakers.forEach(b => {
      const sprite = this.add.image(b.x, b.y, 'breaker_sprite').setPipeline('Light2D');
      this.breakerSprites.set(b.id, sprite);
    });

    this.rockSprites = new Map();
    this.mapData.rocks.forEach(r => this.addRock(r));

    // Carrots only exist under STARVE
    this.carrotSprites = new Map();
    if (this.cfg.starve) {
      this.mapData.carrots.forEach((c) => {
        const sprite = this.add.image(c.x, c.y, 'carrot_sprite').setPipeline('Light2D').setDepth(2);
        sprite.setVisible(!c.respawnAt);
        this.carrotSprites.set(c.id, sprite);
      });
    }
  }

  addRock(r) {
    const sprite = this.add.image(r.x, r.y, 'rock_sprite').setPipeline('Light2D').setDepth(2);
    this.rockSprites.set(r.id, sprite);
    return sprite;
  }

  removeRock(id) {
    const sprite = this.rockSprites.get(id);
    if (sprite) sprite.destroy();
    this.rockSprites.delete(id);
  }

  // Ask the server to throw a rock at a point; it decides where it lands and what it hits
  throwRock(x, y) {
    if (this.rocks <= 0) return;
    this.socket.emit('rock:throw', { x: Math.round(x), y: Math.round(y) });
  }

  announceRules() {
    const { RULES } = window.RULESET;
    const rules = this.roomData.activeRules;
    // Every rule beyond the level-1 basics gets announced; stacked rules share the banner
    const news = rules.length > 1 ? rules.filter(r => r !== 'MOVE') : rules;
    const titles = news.filter(r => !RULES[r].debuff).map(r => RULES[r].title);
    if (this.isCobb) {
      this.showRuleBanner('YOU ARE COBB', `Catch every survivor before one escapes. The fire's light keeps you out. ${titles.join(', ')}.`);
    } else {
      this.showRuleBanner(titles.join(' + ') || RULES[news[0]].title, news.map(r => RULES[r].desc).join(' '));
    }

    const strip = document.getElementById('hud-rules');
    strip.innerHTML = '';
    const level = document.createElement('span');
    level.className = 'hud-rule';
    level.textContent = `LEVEL ${this.roomData.level}`;
    strip.appendChild(level);
    rules.forEach((r) => {
      const tag = document.createElement('span');
      tag.className = `hud-rule ${RULES[r].debuff ? 'debuff' : ''}`;
      tag.textContent = RULES[r].title;
      tag.title = RULES[r].desc;
      strip.appendChild(tag);
    });

    document.getElementById('hud-freeze-container').classList.toggle('hidden', !this.cfg.freeze);
    document.getElementById('hud-starve-container').classList.toggle('hidden', !this.cfg.starve);
  }

  createPlayer() {
    this.player = this.physics.add.sprite(this.me.x, this.me.y, this.isCobb ? 'cobb_sprite' : 'player_sprite')
      .setPipeline('Light2D');
    this.player.setCollideWorldBounds(true);
    if (this.isCobb) {
      this.player.body.setSize(18, 22);
      this.player.body.setOffset(7, 9);
    } else {
      this.player.setTint(this.me.color);
      this.player.body.setSize(18, 18);
      this.player.body.setOffset(7, 7);
    }
    this.player.setDepth(10); // Render above floor and items

    this.player.stamina = window.CONSTANTS.PLAYER.MAX_STAMINA;
    this.player.hasCoal = false;
    this.player.isSprinting = false;

    // Collide with Walls & Furnace
    this.physics.add.collider(this.player, this.layer);
    this.physics.add.collider(this.player, this.furnaceSprite);
  }

  addCobb(c) {
    // Lit like everything else: in the dark, Cobb is a shape you barely see
    const sprite = this.add.sprite(c.x, c.y, 'cobb_sprite').setPipeline('Light2D');
    sprite.setDepth(11); // Render on top
    sprite.setFlipX(c.flipX);
    sprite.targetX = c.x;
    sprite.targetY = c.y;
    this.cobbs.set(c.id, sprite);
    return sprite;
  }

  // COBB CAN MIMIC: wear a survivor's look (no lantern, though) until close or hunting
  applyMimic(sprite, c) {
    const face = c.mimicId && this.roomData.players.find(p => p.id === c.mimicId);
    const close = Phaser.Math.Distance.Between(sprite.x, sprite.y, this.player.x, this.player.y) < 90;
    const disguised = !!face && !close && c.state !== 'CHASE';
    sprite.setTexture(disguised ? 'player_sprite' : 'cobb_sprite');
    if (disguised) sprite.setTint(face.color);
    if (!sprite.fakeLabel && face) {
      sprite.fakeLabel = this.add.text(0, 0, face.name, {
        fontFamily: 'Share Tech Mono, monospace',
        fontSize: '8px',
        color: `#${face.color.toString(16).padStart(6, '0')}`,
        resolution: 4
      }).setOrigin(0.5, 1).setDepth(12);
    }
    if (sprite.fakeLabel) {
      sprite.fakeLabel.setVisible(disguised && !this.isCobb);
      sprite.fakeLabel.setPosition(sprite.x, sprite.y - 14);
    }
  }

  // Tighter smoothing than for players: a Cobb drawn behind its real position makes grabs look unfair
  updateCobbs(delta) {
    const t = Math.min(1, delta / 40);
    this.cobbs.forEach((sprite) => {
      sprite.x += (sprite.targetX - sprite.x) * t;
      sprite.y += (sprite.targetY - sprite.y) * t;
    });
  }

  createLighting() {
    const L = window.CONSTANTS.LIGHTS;
    const f = this.mapData.furnace;
    const e = this.mapData.exit;
    // Cobb has no lantern, just a dim red sense of its surroundings that only its player sees
    this.lanternLight = this.isCobb
      ? this.lights.addLight(this.player.x, this.player.y, 110, 0xff5555, 1.0)
      : this.lights.addLight(this.player.x, this.player.y, L.LANTERN_RADIUS, 0xffcf8a, 1.2);
    this.furnaceLight = this.lights.addLight(f.x, f.y, window.CONSTANTS.furnaceRadius(f.fuel), 0xff7a2a, 1.6);
    this.exitLight = this.lights.addLight(e.x, e.y, 70, 0xff3344, 1.2);

    // Lamps hang in rooms and only shine while their breaker is on
    this.lampLights = new Map();
    this.mapData.breakers.forEach((b) => {
      this.lampLights.set(b.id, b.lamps.map((l) => {
        this.add.image(l.x, l.y, 'lamp_sprite').setPipeline('Light2D').setDepth(3);
        return this.lights.addLight(l.x, l.y, L.BRAZIER_RADIUS, 0xfff0c0, 0);
      }));
      this.setBreaker(b.id, b.active);
    });
    this.setExitUnlocked(e.unlocked);
  }

  setBreaker(id, active) {
    this.mapData.breakers.find(b => b.id === id).active = active;
    this.lampLights.get(id).forEach(light => light.setIntensity(active ? 1.6 : 0));
    this.breakerSprites.get(id).setTint(active ? 0x7dffa8 : 0xffffff);
  }

  setExitUnlocked(unlocked) {
    this.mapData.exit.unlocked = unlocked;
    this.exitLight.setColor(unlocked ? 0x38ef7d : 0xff3344);
  }

  // Flicker the flames; the furnace's reach follows its fuel
  updateLights() {
    const t = this.time.now;
    const lanternOn = this.status === 'active' || this.status === 'downed';
    this.lanternLight.setPosition(this.player.x, this.player.y);
    if (this.isCobb) return this.updateFurnaceLight(t);
    const L = window.CONSTANTS.LIGHTS;
    this.lanternLight.setRadius(this.status === 'downed' ? 60 : (this.lanternDim ? L.LANTERN_STEALTH : L.LANTERN_RADIUS));
    this.lanternLight.setIntensity(lanternOn ? 1.9 + Math.sin(t / 150) * 0.12 : 0);
    this.updateFurnaceLight(t);
  }

  updateFurnaceLight(t) {
    const fuel = this.mapData.furnace.fuel;
    this.furnaceLight.setRadius(window.CONSTANTS.furnaceRadius(fuel) * (1 + Math.sin(t / 200) * 0.03));
    this.furnaceLight.setIntensity(fuel > 0 ? 2.4 : 1.0);
  }

  update(time, delta) {
    if (!this.player || !this.player.body) return;

    const active = this.status === 'active';
    this.readPad();
    this.handleMapToggle();
    if (Phaser.Input.Keyboard.JustDown(this.wasd.mute)) {
      const muted = window.Sound.toggleMute();
      this.showRuleBanner(muted ? 'SOUND OFF' : 'SOUND ON', 'Press N to toggle sound.');
    }
    if (this.isCobb) {
      this.handleCobbMovement();
    } else if (active && this.time.now < this.stunnedUntil) {
      this.player.setVelocity(0, 0); // RACE: dazed by a rival's rock
    } else if (active) {
      if (Phaser.Input.Keyboard.JustDown(this.wasd.lantern) || this.pad.yDown) {
        this.lanternDim = !this.lanternDim;
        this.updateHUD();
      }
      if (Phaser.Input.Keyboard.JustDown(this.wasd.throw) || this.pad.bDown) {
        const dir = this.player.flipX ? -1 : 1;
        this.throwRock(this.player.x + dir * 200, this.player.y);
      }
      this.updateReviving();
      this.handlePlayerMovement(delta);
      this.handleInteractions();
    } else {
      this.player.setVelocity(0, 0);
    }
    this.updateRemotePlayers(delta);
    this.updateCobbs(delta);
    this.updateLights();
    this.updateMinimap(delta);
    this.updateWarnings();
    this.updateAudio(delta);
    this.animateWalkers(time);

    // Network Sync (20 ticks/sec)
    this.networkSendTimer -= delta;
    if (active && this.networkSendTimer <= 0) {
      this.networkSendTimer = 50;
      this.socket.emit('player:move', {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        flipX: this.player.flipX,
        isSprinting: this.player.isSprinting,
        lanternDim: this.lanternDim
      });
    }
  }

  addRemotePlayer(p) {
    const remote = this.add.sprite(p.x, p.y, 'player_sprite').setPipeline('Light2D');
    // Teammates carry lanterns too, so you can spot them across a dark room
    remote.light = this.lights.addLight(p.x, p.y, window.CONSTANTS.LIGHTS.LANTERN_RADIUS, 0xffcf8a, 1.1);
    remote.setDepth(10);
    remote.setTint(p.color);
    remote.setFlipX(!!p.flipX);
    remote.targetX = p.x;
    remote.targetY = p.y;
    remote.name = p.name;
    remote.color = p.color;
    remote.state = 'active';
    remote.bleedLeft = 0;
    remote.progress = 0;
    remote.colorHex = `#${p.color.toString(16).padStart(6, '0')}`;
    remote.label = this.add.text(p.x, p.y - 14, p.name, {
      fontFamily: 'Share Tech Mono, monospace',
      fontSize: '8px',
      color: remote.colorHex,
      resolution: 4
    }).setOrigin(0.5, 1).setDepth(12);
    this.remotePlayers.set(p.id, remote);
  }

  removeRemotePlayer(id) {
    const remote = this.remotePlayers.get(id);
    if (!remote) return;
    remote.label.destroy();
    this.lights.removeLight(remote.light);
    remote.destroy();
    this.remotePlayers.delete(id);
    if (this.spectating === remote) this.spectate();
  }

  // Ease remote players toward their latest reported position, and keep labels current
  updateRemotePlayers(delta) {
    const t = Math.min(1, delta / 80);
    this.remotePlayers.forEach((remote) => {
      remote.x += (remote.targetX - remote.x) * t;
      remote.y += (remote.targetY - remote.y) * t;
      remote.label.setPosition(remote.x, remote.y - 14);
      remote.light.setPosition(remote.x, remote.y);
      // Downed lanterns gutter; the dead carry none
      const L = window.CONSTANTS.LIGHTS;
      remote.light.setRadius(remote.state === 'downed' ? 60 : (remote.lanternDim ? L.LANTERN_STEALTH : L.LANTERN_RADIUS));
      remote.light.setIntensity(remote.state === 'dead' ? 0 : 1.7);

      // Cobb's player gets no name tags: it has to find people by their light
      remote.label.setVisible(!this.isCobb);
      remote.light.setIntensity(remote.away ? 0 : remote.light.intensity);
      let text = remote.name;
      if (remote.away) {
        text += ' · AWAY';
      } else if (remote.state === 'dead') {
        text += ' · DEAD';
      } else if (remote.state === 'downed') {
        text += remote.progress > 0
          ? ` · REVIVING ${Math.round(remote.progress * 100)}%`
          : ` · DOWN ${Math.ceil(remote.bleedLeft / 1000)}s`;
        if (this.reviveTarget === remote && !this.reviving) text += ' · HOLD E';
      }
      if (remote.label.text !== text) remote.label.setText(text);
    });
  }

  // Hold E next to a downed teammate to revive them; the server checks range and timing
  updateReviving() {
    const radius = window.CONSTANTS.PLAYER.REVIVE_RADIUS;
    this.reviveTarget = null;
    this.remotePlayers.forEach((remote) => {
      if (remote.state === 'downed' &&
          Phaser.Math.Distance.Between(this.player.x, this.player.y, remote.x, remote.y) <= radius) {
        this.reviveTarget = remote;
      }
    });
    this.setReviving(!!this.reviveTarget && (this.wasd.interact.isDown || this.wasd.space.isDown || this.pad.a));
  }

  setReviving(active) {
    if (active === this.reviving) return;
    this.reviving = active;
    this.socket.emit('player:reviving', { active });
  }

  // Camera follows a teammate who is still in the round
  spectate() {
    const remotes = Array.from(this.remotePlayers.values());
    this.spectating = remotes.find(r => r.state === 'active') || remotes.find(r => r.state === 'downed') || null;
    if (this.spectating) this.cameras.main.startFollow(this.spectating, true, 0.1, 0.1);
  }

  // Apply a player's new state (active, downed, dead, escaped) to whoever it belongs to
  applyPlayerState(id, state) {
    if (id === this.myId) {
      this.setMyState(state);
      return;
    }
    const remote = this.remotePlayers.get(id);
    if (!remote || remote.state === state) return;
    if (state === 'escaped') {
      this.removeRemotePlayer(id);
      return;
    }
    remote.state = state;
    remote.progress = 0;
    remote.setAngle(state === 'active' ? 0 : 90);
    remote.setTint(state === 'active' ? remote.color : (state === 'downed' ? DOWNED_TINT : DEAD_TINT));
    if (this.spectating === remote && state === 'dead') this.spectate();
  }

  setMyState(state) {
    if (this.status === state) return;
    this.status = state;
    this.setReviving(false);
    this.player.setVelocity(0, 0);

    if (state === 'active') {
      this.player.setAngle(0);
      this.player.setTint(this.me.color);
      this.cameras.main.flash(250, 255, 255, 255);
      this.showRuleBanner('BACK ON YOUR FEET', 'Get moving. Cobb is still out there.');
    } else if (state === 'downed') {
      this.player.setAngle(90);
      this.player.setTint(DOWNED_TINT);
      this.player.hasCoal = false;
      this.cameras.main.shake(300, 0.03);
      this.cameras.main.flash(300, 160, 0, 0);
    } else if (state === 'dead') {
      this.player.setTint(DEAD_TINT);
      this.showRuleBanner('YOU DIED', 'Spectating your team...');
      this.spectate();
    } else if (state === 'escaped') {
      this.player.setVisible(false);
      this.player.body.enable = false;
      this.showRuleBanner('YOU ESCAPED', 'Waiting for the others to get out...');
      this.spectate();
    }
    this.updateHUD();
  }

  handleMapToggle() {
    if (!Phaser.Input.Keyboard.JustDown(this.wasd.map) && !this.pad.backDown) return;
    const minimapBox = document.getElementById('minimap-box');
    const btnToggle = document.getElementById('btn-toggle-map');
    minimapBox.classList.toggle('expanded');
    btnToggle.textContent = minimapBox.classList.contains('expanded') ? '[M] CLOSE' : '[M] FULL';
  }

  // First connected gamepad: left stick moves, RT/LB sprints, A interacts and revives,
  // B throws, Y shutters the lantern, Back opens the map. Button presses are edge-detected.
  readPad() {
    const gp = this.input.gamepad && this.input.gamepad.total ? this.input.gamepad.getPad(0) : null;
    const now = gp ? {
      x: Math.abs(gp.leftStick.x) > 0.25 ? gp.leftStick.x : 0,
      y: Math.abs(gp.leftStick.y) > 0.25 ? gp.leftStick.y : 0,
      sprint: gp.R2 > 0.5 || gp.L1 > 0.5,
      a: gp.A,
      b: gp.B,
      yb: gp.Y,
      back: !!(gp.buttons[8] && gp.buttons[8].pressed)
    } : { x: 0, y: 0, sprint: false, a: false, b: false, yb: false, back: false };
    const prev = this.padPrev;
    this.pad = {
      ...now,
      aDown: now.a && !prev.a,
      bDown: now.b && !prev.b,
      yDown: now.yb && !prev.yb,
      backDown: now.back && !prev.back
    };
    this.padPrev = now;
  }

  // Footsteps, heartbeat and Cobb's breathing get louder as Cobb gets closer; the fire roars nearby
  updateAudio(delta) {
    const S = window.Sound;
    const me = this.player;
    let nearest = Infinity;
    this.cobbs.forEach((c) => {
      nearest = Math.min(nearest, Phaser.Math.Distance.Between(me.x, me.y, c.x, c.y));
    });
    const hunted = !this.isCobb && (this.status === 'active' || this.status === 'downed');
    const danger = hunted ? Math.max(0, 1 - nearest / 320) : 0;
    S.setBreath(hunted ? Math.max(0, 1 - nearest / 380) : 0);

    const f = this.mapData.furnace;
    const toFire = Phaser.Math.Distance.Between(me.x, me.y, f.x, f.y);
    S.setFire(Math.max(0, 1 - toFire / 420) * (f.fuel > 0 ? 1 : 0.2));

    this.beatTimer -= delta;
    if (danger > 0 && this.beatTimer <= 0) {
      S.heartbeat(danger);
      this.beatTimer = 900 - 550 * danger; // the closer it is, the faster your heart
    }

    this.stepTimer -= delta;
    const moving = me.body.velocity.lengthSq() > 100;
    if (moving && this.status === 'active' && this.stepTimer <= 0) {
      S.footstep(me.isSprinting, this.isCobb ? 0.6 : 1);
      this.stepTimer = me.isSprinting ? 220 : 330;
    }
  }

  // Volume for a sound at a world point, fading out by `range` px
  volumeAt(x, y, range = 500) {
    return Math.max(0, 1 - Phaser.Math.Distance.Between(this.player.x, this.player.y, x, y) / range);
  }

  // Cheap walk cycle: a waddle while moving; Cobb lurches slower and wider
  animateWalkers(time) {
    const wobble = (sprite, moving, speed, size) => sprite.setAngle(moving ? Math.sin(time / speed) * size : 0);
    if (this.status === 'active') {
      wobble(this.player, this.player.body.velocity.lengthSq() > 100, this.isCobb ? 140 : 70, this.isCobb ? 7 : 5);
    }
    this.remotePlayers.forEach((r) => {
      if (r.state === 'active') wobble(r, Math.abs(r.targetX - r.x) + Math.abs(r.targetY - r.y) > 1, 70, 5);
    });
    this.cobbs.forEach((c) => {
      wobble(c, Math.abs(c.targetX - c.x) + Math.abs(c.targetY - c.y) > 1, 140, 7);
    });
  }

  // VERSUS: steer Cobb. No sprint, no items; the fire's light pushes you back out.
  handleCobbMovement() {
    let moveX = 0;
    let moveY = 0;
    if (this.cursors.left.isDown || this.wasd.left.isDown) moveX -= 1;
    if (this.cursors.right.isDown || this.wasd.right.isDown) moveX += 1;
    if (this.cursors.up.isDown || this.wasd.up.isDown) moveY -= 1;
    if (this.cursors.down.isDown || this.wasd.down.isDown) moveY += 1;
    if (!moveX && !moveY) {
      moveX = this.pad.x;
      moveY = this.pad.y;
    }
    if (moveX < 0) this.player.setFlipX(true);
    else if (moveX > 0) this.player.setFlipX(false);
    if (this.cobbHeld) moveX = moveY = 0;

    const C = window.CONSTANTS;
    const speed = C.VERSUS.COBB_SPEED * this.cfg.speedMul * (this.cfg.cantMove ? C.COBB.UNWATCHED_MUL : 1);
    const velocity = new Phaser.Math.Vector2(moveX, moveY).normalize().scale(speed);
    this.player.setVelocity(velocity.x, velocity.y);

    const f = this.mapData.furnace;
    const safe = C.safeRadius(f.fuel);
    const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, f.x, f.y);
    if (d < safe && d > 0) {
      this.player.x = f.x + ((this.player.x - f.x) / d) * safe;
      this.player.y = f.y + ((this.player.y - f.y) / d) * safe;
    }
  }

  // Warnings for co-op twists: straying under TETHERED, hot coal under HOT COAL
  updateWarnings() {
    const el = document.getElementById('hud-warning');
    let text = '';
    if (!this.isCobb && this.status === 'active') {
      if (this.cfg.tethered) {
        const near = Array.from(this.remotePlayers.values()).some(r => r.state === 'active' && !r.away &&
          Phaser.Math.Distance.Between(this.player.x, this.player.y, r.x, r.y) <= window.CONSTANTS.TWISTS.TETHER_RANGE);
        if (!near && this.remotePlayers.size) text = 'ALONE: COBB KNOWS WHERE YOU ARE';
      }
      if (this.cfg.hotCoal && this.player.hasCoal) {
        const left = Math.ceil((window.CONSTANTS.TWISTS.HOT_COAL_TIME - (Date.now() - this.coalSince)) / 1000);
        text = `HOT COAL: ${Math.max(0, left)}s BEFORE YOU DROP IT`;
      }
    }
    if (el.textContent !== text) {
      el.textContent = text;
      el.classList.toggle('hidden', !text);
    }
  }

  handlePlayerMovement(delta) {
    const dt = delta / 1000;
    let moveX = 0;
    let moveY = 0;

    if (this.cursors.left.isDown || this.wasd.left.isDown) moveX -= 1;
    if (this.cursors.right.isDown || this.wasd.right.isDown) moveX += 1;
    if (this.cursors.up.isDown || this.wasd.up.isDown) moveY -= 1;
    if (this.cursors.down.isDown || this.wasd.down.isDown) moveY += 1;
    // Gamepad stick when the keyboard is idle (analog: a light push walks slower)
    let analog = 1;
    if (!moveX && !moveY && (this.pad.x || this.pad.y)) {
      moveX = this.pad.x;
      moveY = this.pad.y;
      analog = Math.min(1, Math.hypot(moveX, moveY));
    }

    // Flip sprite facing direction
    if (moveX < 0) this.player.setFlipX(true);
    else if (moveX > 0) this.player.setFlipX(false);

    // Sprinting check
    const wantsSprint = (this.wasd.shift.isDown || this.pad.sprint) && (moveX !== 0 || moveY !== 0);

    if (wantsSprint && this.player.stamina > 5) {
      this.player.isSprinting = true;
      this.player.stamina = Math.max(0, this.player.stamina - window.CONSTANTS.PLAYER.STAMINA_DRAIN * dt);
    } else {
      this.player.isSprinting = false;
      this.player.stamina = Math.min(
        window.CONSTANTS.PLAYER.MAX_STAMINA,
        this.player.stamina + window.CONSTANTS.PLAYER.STAMINA_RECOVER * dt
      );
    }

    const currentSpeed = this.player.isSprinting
      ? window.CONSTANTS.PLAYER.SPRINT_SPEED
      : window.CONSTANTS.PLAYER.BASE_SPEED;

    // Reviving means standing still
    if (this.reviving) moveX = moveY = 0;
    const velocity = new Phaser.Math.Vector2(moveX, moveY).normalize().scale(currentSpeed * analog);
    this.player.setVelocity(velocity.x, velocity.y);

    // Update Stamina Bar in HUD
    const staminaFill = document.getElementById('stamina-fill');
    if (staminaFill) {
      const pct = (this.player.stamina / window.CONSTANTS.PLAYER.MAX_STAMINA) * 100;
      staminaFill.style.width = `${pct}%`;
      staminaFill.style.background = this.player.stamina < 20 ? 'var(--accent-red)' : 'var(--accent-cyan)';
    }
  }

  handleInteractions() {
    const justPressedInteract = Phaser.Input.Keyboard.JustDown(this.wasd.interact) ||
                                Phaser.Input.Keyboard.JustDown(this.wasd.space) || this.pad.aDown;

    if (!justPressedInteract) return;

    const px = this.player.x;
    const py = this.player.y;
    const radius = window.CONSTANTS.PLAYER.INTERACTION_RADIUS;

    // 1. Coal Pickup
    if (!this.player.hasCoal) {
      for (const [id, sprite] of this.coalMap.entries()) {
        if (sprite.active && Phaser.Math.Distance.Between(px, py, sprite.x, sprite.y) <= radius) {
          this.pickupCoal(id);
          return;
        }
      }
    }

    // 2. Furnace Deposit
    if (this.player.hasCoal) {
      const fDist = Phaser.Math.Distance.Between(px, py, this.furnaceSprite.x, this.furnaceSprite.y);
      if (fDist <= radius + 25) {
        this.depositCoal();
        return;
      }
    }

    // 3. Eat a carrot (STARVE)
    for (const [id, sprite] of this.carrotSprites) {
      if (sprite.visible && Phaser.Math.Distance.Between(px, py, sprite.x, sprite.y) <= radius) {
        this.socket.emit('carrot:eat', { carrotId: id });
        return;
      }
    }

    // 4. Pick up a rock
    if (this.rocks < window.CONSTANTS.PLAYER.ROCK_MAX) {
      for (const [id, sprite] of this.rockSprites) {
        if (Phaser.Math.Distance.Between(px, py, sprite.x, sprite.y) <= radius) {
          this.socket.emit('rock:pickup', { rockId: id });
          return;
        }
      }
    }

    // 5. Breakers switch a wing's lamps on or off
    for (const b of this.mapData.breakers) {
      if (Phaser.Math.Distance.Between(px, py, b.x, b.y) <= radius) {
        this.socket.emit('breaker:toggle', { breakerId: b.id });
        return;
      }
    }

    // 6. Exit Escape
    if (this.mapData.exit.unlocked) {
      const eDist = Phaser.Math.Distance.Between(px, py, this.exitDoorSprite.x, this.exitDoorSprite.y);
      if (eDist <= radius + 15) {
        this.escape();
        return;
      }
    }
  }

  // Item actions are requests; the server's reply decides who got what
  pickupCoal(coalId) {
    this.socket.emit('coal:pickup', { coalId });
  }

  depositCoal() {
    this.socket.emit('furnace:deposit');
  }

  escape() {
    this.socket.emit('player:escape');
  }

  showRuleBanner(ruleName, subtitle) {
    const banner = document.getElementById('rule-banner');
    const titleText = document.getElementById('banner-rule-text');
    const subText = document.getElementById('banner-rule-sub');
    if (!banner || !titleText) return;

    titleText.textContent = ruleName;
    subText.textContent = subtitle || '';
    banner.classList.remove('hidden');

    // A newer banner must not be hidden by an older one's timer
    clearTimeout(banner.hideTimer);
    banner.hideTimer = setTimeout(() => {
      banner.classList.add('hidden');
    }, 4500);
  }

  updateHUD() {
    const coalElem = document.getElementById('hud-coal-count');
    const exitElem = document.getElementById('hud-exit-status');
    const heldElem = document.getElementById('held-item-name');

    if (coalElem) {
      coalElem.textContent = this.isRace
        ? `${this.me.deposited || 0} / ${this.mapData.furnace.coalRequired} (YOURS)`
        : `${this.mapData.furnace.coalDeposited} / ${this.mapData.furnace.coalRequired}`;
    }
    document.querySelectorAll('.hud-bottom-bar .item-slot').forEach(el => el.classList.toggle('hidden', this.isCobb));
    if (exitElem) {
      if (this.mapData.exit.unlocked) {
        exitElem.textContent = 'UNLOCKED';
        exitElem.className = 'unlocked';
      } else {
        exitElem.textContent = 'LOCKED';
        exitElem.className = 'locked';
      }
    }
    if (heldElem) {
      heldElem.textContent = this.player.hasCoal ? '⬛ COAL CHUNK' : 'HANDS EMPTY';
      heldElem.style.color = this.player.hasCoal ? 'var(--accent-amber)' : 'var(--text-main)';
    }
    this.updateFireHUD();
    document.getElementById('hud-rocks').textContent = `ROCKS: ${this.rocks}`;
    document.getElementById('hud-lantern').textContent = this.lanternDim ? 'SHUTTERED' : 'FULL';
  }

  updateVitalsHUD() {
    const show = (id, value) => {
      const el = document.getElementById(id);
      el.textContent = `${Math.round(value)}%`;
      el.className = value < 25 ? 'locked' : '';
    };
    show('hud-warmth', this.vitals.warmth);
    show('hud-hunger', this.vitals.hunger);
  }

  // Fuel left in the furnace; under a quarter, the safe zone is about to shrink to nothing
  updateFireHUD() {
    const fireElem = document.getElementById('hud-fire');
    const pct = Math.round((this.mapData.furnace.fuel / window.CONSTANTS.FURNACE.MAX_FUEL) * 100);
    const text = pct > 0 ? `${pct}%` : 'OUT';
    if (fireElem.textContent !== text) {
      fireElem.textContent = text;
      fireElem.className = pct < 25 ? 'locked' : '';
    }
  }

  setupNetworkHandlers() {
    const handlers = {
      'player:moved': (data) => {
        const remote = this.remotePlayers.get(data.id);
        if (!remote) return;
        remote.targetX = data.x;
        remote.targetY = data.y;
        remote.setFlipX(data.flipX);
        remote.lanternDim = data.lanternDim;
      },

      // Server rejected a move (too fast or out of bounds)
      'player:correct': (data) => {
        this.player.setPosition(data.x, data.y);
      },

      'player:left': (data) => {
        this.removeRemotePlayer(data.id);
      },

      // Dropped connections: their seat is held for a while, then they may come back as a new id
      'player:away': (data) => {
        const remote = this.remotePlayers.get(data.id);
        if (remote) remote.away = true;
      },
      'player:rejoined': (data) => {
        const remote = this.remotePlayers.get(data.oldId);
        if (!remote) return;
        this.remotePlayers.delete(data.oldId);
        this.remotePlayers.set(data.newId, remote);
        remote.away = false;
      },

      // RACE: a rival's rock dazes you
      'player:stunned': (data) => {
        if (data.id === this.myId) {
          this.stunnedUntil = this.time.now + data.ms;
          this.cameras.main.shake(200, 0.02);
          this.showRuleBanner('DAZED', 'A rival hit you with a rock.');
          return;
        }
        const remote = this.remotePlayers.get(data.id);
        if (remote) this.tweens.add({ targets: remote, alpha: 0.3, duration: 120, yoyo: true, repeat: 4 });
      },

      // VERSUS + SMELL: the Cobb player sees fresh scent as fading dots
      'cobb:scent': (data) => {
        if (!this.scentGfx) this.scentGfx = this.add.graphics().setDepth(3);
        this.scentGfx.clear();
        data.crumbs.forEach((c) => {
          this.scentGfx.fillStyle(0x9cff6b, Math.max(0.1, 0.8 - c.age / window.CONSTANTS.TRAIL.LIFE));
          this.scentGfx.fillCircle(c.x, c.y, 3);
        });
      },

      'player:escaped': (data) => {
        if (data.id === this.myId) window.Sound.escape();
        this.applyPlayerState(data.id, 'escaped');
      },
      'player:downed': (data) => {
        if (data.id === this.myId) window.Sound.grab();
        this.applyPlayerState(data.id, 'downed');
      },
      'player:revived': (data) => {
        if (data.id === this.myId || data.by === this.myId) window.Sound.revive();
        this.applyPlayerState(data.id, 'active');
      },
      'player:died': (data) => {
        if (data.id === this.myId) window.Sound.death();
        this.applyPlayerState(data.id, 'dead');
      },

      // Coal a downed or departed player was carrying, back on the floor
      'coal:dropped': (data) => {
        this.placeCoal({ id: data.coalId, x: data.x, y: data.y, collected: false });
        if (data.droppedBy === this.myId) this.player.hasCoal = false;
        this.updateHUD();
      },

      'breaker:updated': (data) => {
        this.setBreaker(data.breakerId, data.active);
        const b = this.mapData.breakers.find(br => br.id === data.breakerId);
        window.Sound.breaker(this.volumeAt(b.x, b.y, 700));
      },

      'rock:taken': (data) => {
        this.removeRock(data.rockId);
        if (data.by === this.myId) {
          this.rocks = data.rocks;
          this.updateHUD();
        }
      },

      // The rock arcs from the thrower to where it landed, then lies there to be picked up again
      'rock:thrown': (data) => {
        if (data.by === this.myId) {
          this.rocks -= 1;
          this.updateHUD();
        }
        const sprite = this.addRock({ id: data.rock.id, x: data.from.x, y: data.from.y });
        this.tweens.add({ targets: sprite, x: data.rock.x, y: data.rock.y, duration: 220, ease: 'Quad.easeOut' });
        if (data.by === this.myId) window.Sound.rockThrow();
        this.time.delayedCall(220, () => window.Sound.rockLand(this.volumeAt(data.rock.x, data.rock.y)));
        if (data.hitCobb) {
          this.cameras.main.flash(120, 200, 220, 255);
          window.Sound.stun();
        }
      },

      'carrot:updated': (data) => {
        const sprite = this.carrotSprites.get(data.carrotId);
        if (sprite) sprite.setVisible(data.available);
      },

      // COBB CAN HEAR: show each sound as a ripple so players learn what carries
      'noise': (data) => {
        const ring = this.add.circle(data.x, data.y, 6).setStrokeStyle(1, 0xffffff, 0.5).setDepth(4);
        this.tweens.add({
          targets: ring,
          radius: data.radius,
          alpha: 0,
          duration: 700,
          onComplete: () => ring.destroy()
        });
      },

      'world:tick': (data) => {
        this.mapData.furnace.fuel = data.fuel;
        this.updateFireHUD();
        const mine = data.vitals && data.vitals.find(v => v.id === this.myId);
        if (mine) {
          this.vitals = mine;
          this.updateVitalsHUD();
        }
        data.cobbs.forEach((c) => {
          // VERSUS: we are this Cobb; just learn whether it may move right now
          if (c.controlledBy === this.myId) {
            this.cobbHeld = c.paused || c.frozen;
            this.player.setTint(c.frozen ? 0x8899ff : 0xffffff);
            return;
          }
          const sprite = this.cobbs.get(c.id) || this.addCobb(c);
          sprite.targetX = c.x;
          sprite.targetY = c.y;
          sprite.setFlipX(c.flipX);
          // Frozen by a watching light: cold blue. Stunned by a rock: flickers.
          sprite.setTint(c.frozen ? 0x8899ff : 0xffffff);
          sprite.setAlpha(c.stunned ? 0.5 + Math.sin(this.time.now / 60) * 0.3 : 1);
          this.applyMimic(sprite, c);
          // Jolt the camera the moment Cobb locks on to us
          const chasingMe = c.state === 'CHASE' && c.targetId === this.myId;
          if (chasingMe && !sprite.chasingMe) this.cameras.main.shake(150, 0.01);
          sprite.chasingMe = chasingMe;
        });

        data.downed.forEach((d) => {
          if (d.id === this.myId) {
            const sub = d.progress > 0
              ? `Being revived... ${Math.round(d.progress * 100)}%`
              : `A teammate can hold E next to you to revive you. Bleeding out in ${Math.ceil(d.bleedLeft / 1000)}s.`;
            this.showRuleBanner("YOU'RE DOWN", sub);
            return;
          }
          const remote = this.remotePlayers.get(d.id);
          if (remote) {
            remote.bleedLeft = d.bleedLeft;
            remote.progress = d.progress;
          }
        });
      },

      'coal:updated': (data) => {
        const sprite = this.coalMap.get(data.coalId);
        if (sprite) {
          sprite.destroy();
          this.coalMap.delete(data.coalId);
        }
        if (data.collectedBy === this.myId) {
          window.Sound.coal();
          this.player.hasCoal = true;
          this.coalSince = Date.now();
          this.cameras.main.flash(150, 255, 170, 34);
          this.updateHUD();
        }
      },

      'furnace:updated': (data) => {
        this.mapData.furnace.coalDeposited = data.coalDeposited;
        this.mapData.furnace.fuel = data.fuel;
        if (data.depositedBy === this.myId) this.me.deposited = data.playerDeposited;
        // In a race the exit opens per player, once your own quota is in
        const open = this.isRace ? (this.me.deposited || 0) >= this.mapData.furnace.coalRequired : data.exitUnlocked;
        this.setExitUnlocked(open);
        if (data.depositedBy === this.myId) {
          window.Sound.deposit();
          this.player.hasCoal = false;
          if (open) {
            this.cameras.main.flash(500, 56, 239, 125);
          } else {
            this.cameras.main.flash(200, 255, 100, 0);
          }
        }
        this.updateHUD();
      }
    };

    // Listeners live on the shared socket, so drop them when this game is torn down
    Object.entries(handlers).forEach(([event, fn]) => this.socket.on(event, fn));
    const detach = () => Object.entries(handlers).forEach(([event, fn]) => this.socket.off(event, fn));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, detach);
    this.events.once(Phaser.Scenes.Events.DESTROY, detach);
  }

  // Show a coal chunk where the server says it is, or remove it once collected
  placeCoal(c) {
    let sprite = this.coalMap.get(c.id);
    if (c.collected) {
      if (sprite) sprite.destroy();
      this.coalMap.delete(c.id);
      return;
    }
    if (!sprite) {
      sprite = this.coalGroup.create(c.x, c.y, 'coal_sprite').setPipeline('Light2D');
      sprite.coalId = c.id;
      this.coalMap.set(c.id, sprite);
    }
    sprite.setPosition(c.x, c.y);
    sprite.refreshBody();
  }

  // Bring the scene in line with the server's current round state
  applySnapshot(room) {
    room.mapData.coal.forEach(c => this.placeCoal(c));

    this.mapData.furnace.coalDeposited = room.mapData.furnace.coalDeposited;
    this.mapData.exit.unlocked = room.mapData.exit.unlocked;
    this.mapData.furnace.fuel = room.mapData.furnace.fuel;
    this.setExitUnlocked(room.mapData.exit.unlocked);
    room.mapData.breakers.forEach(b => this.setBreaker(b.id, b.active));
    // Rocks may have been picked up or thrown while we loaded
    Array.from(this.rockSprites.keys()).forEach(id => this.removeRock(id));
    room.mapData.rocks.forEach(r => this.addRock(r));
    room.mapData.carrots.forEach((c) => {
      const sprite = this.carrotSprites.get(c.id);
      if (sprite) sprite.setVisible(!c.respawnAt);
    });
    const me = room.players.find(p => p.id === this.myId);
    if (me) {
      this.me.deposited = me.deposited;
      if (this.isRace) this.setExitUnlocked(me.deposited >= room.mapData.furnace.coalRequired);
      this.rocks = me.rocks;
      this.vitals = { warmth: me.warmth, hunger: me.hunger };
      this.updateVitalsHUD();
    }

    room.players.forEach((p) => {
      const state = p.isEscaped ? 'escaped' : p.isDead ? 'dead' : p.isDowned ? 'downed' : 'active';
      if (p.id === this.myId) this.player.hasCoal = p.hasCoal;
      this.applyPlayerState(p.id, state);
      const remote = this.remotePlayers.get(p.id);
      if (remote) {
        remote.targetX = p.x;
        remote.targetY = p.y;
      }
    });
    // Players who left while we were loading
    this.remotePlayers.forEach((remote, id) => {
      if (!room.players.some(p => p.id === id)) this.removeRemotePlayer(id);
    });

    this.updateHUD();
  }

  // Facility Radar Minimap System
  initMinimap() {
    this.minimapCanvas = document.getElementById('minimap-canvas');
    if (!this.minimapCanvas) return;
    // 4 px per tile, whatever this level's map size is
    this.minimapCanvas.width = this.mapData.width * 4;
    this.minimapCanvas.height = this.mapData.height * 4;
    this.minimapCtx = this.minimapCanvas.getContext('2d');
    this.minimapUpdateTimer = 0;

    const btnToggle = document.getElementById('btn-toggle-map');
    const minimapBox = document.getElementById('minimap-box');
    if (btnToggle && minimapBox) {
      btnToggle.onclick = () => {
        minimapBox.classList.toggle('expanded');
        btnToggle.textContent = minimapBox.classList.contains('expanded') ? '[M] CLOSE' : '[M] FULL';
      };
    }
  }

  updateMinimap(delta) {
    if (!this.minimapCtx || !this.mapData) return;
    this.minimapUpdateTimer = (this.minimapUpdateTimer || 0) - delta;
    if (this.minimapUpdateTimer > 0) return;
    this.minimapUpdateTimer = 80; // 12 FPS smooth radar update

    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const scale = 4; // px per tile; initMinimap sizes the canvas to match

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);

    // The radar only knows what your lantern has shown you
    const mw = this.mapData.width;
    if (!this.explored) this.explored = new Uint8Array(mw * this.mapData.height);
    const seen = (px, py) => this.explored[Math.floor(py / 32) * mw + Math.floor(px / 32)] === 1;
    if (this.status === 'active' || this.status === 'downed') {
      const r = Math.floor(window.CONSTANTS.LIGHTS.LANTERN_RADIUS / 32);
      const tx = Math.floor(this.player.x / 32);
      const ty = Math.floor(this.player.y / 32);
      for (let y = Math.max(0, ty - r); y <= Math.min(this.mapData.height - 1, ty + r); y++) {
        for (let x = Math.max(0, tx - r); x <= Math.min(mw - 1, tx + r); x++) {
          if (Math.hypot(x - tx, y - ty) <= r) this.explored[y * mw + x] = 1;
        }
      }
    }

    // 1. Draw explored floor rooms & corridors
    ctx.fillStyle = '#1c2130';
    for (let y = 0; y < this.mapData.height; y++) {
      for (let x = 0; x < mw; x++) {
        if (this.mapData.grid[y][x] === 1 && this.explored[y * mw + x]) {
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // 2. Draw Exit Blast Door once found
    const ex = Math.floor(this.mapData.exit.x / 32) * scale;
    const ey = Math.floor(this.mapData.exit.y / 32) * scale;
    if (seen(this.mapData.exit.x, this.mapData.exit.y)) {
      ctx.fillStyle = this.mapData.exit.unlocked ? '#38ef7d' : '#ff3344';
      ctx.fillRect(ex - 2, ey - 2, scale + 4, scale + 4);
    }

    // 3. Draw Furnace
    const fx = Math.floor(this.mapData.furnace.x / 32) * scale;
    const fy = Math.floor(this.mapData.furnace.y / 32) * scale;
    ctx.fillStyle = '#ff6600';
    ctx.fillRect(fx - 2, fy - 2, scale + 4, scale + 4);

    // 4. Draw Coal Chunks
    ctx.fillStyle = '#ffaa22';
    this.coalMap.forEach((sprite) => {
      if (sprite.active && seen(sprite.x, sprite.y)) {
        const cx = Math.floor(sprite.x / 32) * scale;
        const cy = Math.floor(sprite.y / 32) * scale;
        ctx.fillRect(cx + 1, cy + 1, scale - 2, scale - 2);
      }
    });

    // 5. Draw Breakers
    if (this.mapData.breakers) {
      this.mapData.breakers.forEach((b) => {
        if (!seen(b.x, b.y)) return;
        ctx.fillStyle = b.active ? '#7dffa8' : '#00d2ff';
        const bx = Math.floor(b.x / 32) * scale;
        const by = Math.floor(b.y / 32) * scale;
        ctx.fillRect(bx + 1, by + 1, scale - 2, scale - 2);
      });
    }

    // 6. Draw Local Player (Cyan dot with glowing radar pulse)
    const px = (this.player.x / 32) * scale;
    const py = (this.player.y / 32) * scale;
    ctx.fillStyle = '#00d2ff';
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();

    const pulse = (Math.sin(this.time.now / 150) + 1) * 2.5;
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 3 + pulse, 0, Math.PI * 2);
    ctx.stroke();

    // 7. Draw Remote Players in their own colours (survivors only: Cobb has to hunt)
    this.remotePlayers.forEach((remote) => {
      if (remote.active && !this.isCobb) {
        const rx = (remote.x / 32) * scale;
        const ry = (remote.y / 32) * scale;
        ctx.fillStyle = remote.state === 'dead' ? '#555555' : remote.colorHex;
        ctx.beginPath();
        ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // Blinking red ring so teammates can find someone who needs reviving
        if (remote.state === 'downed' && Math.sin(this.time.now / 120) > 0) {
          ctx.strokeStyle = '#ff3344';
          ctx.beginPath();
          ctx.arc(rx, ry, 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
  }
}

window.GameScene = GameScene;
