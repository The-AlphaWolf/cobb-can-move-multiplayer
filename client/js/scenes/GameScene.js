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
  }

  create() {
    console.log('[GameScene] Initializing atmospheric horror dungeon...');

    // 1. Map comes from the server so every player shares it
    this.mapData = this.roomData.mapData;

    const ts = window.CONSTANTS.TILE_SIZE;
    const worldW = this.mapData.width * ts;
    const worldH = this.mapData.height * ts;

    // 2. Build Dungeon Tilemap (Floors & Walls)
    this.wallsGroup = this.physics.add.staticGroup();
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
    this.roomData.cobbs.forEach(c => this.addCobb(c));

    // 8. Remote Players, placed at their server-assigned spawns
    this.remotePlayers = new Map();
    this.roomData.players
      .filter(p => p.id !== this.myId && !p.isEscaped)
      .forEach(p => this.addRemotePlayer(p));

    // 9. Setup Darkness / Horror Vision System
    this.createDarknessLayer(worldW, worldH);

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
      map: Phaser.Input.Keyboard.KeyCodes.M
    });

    // 12. Setup Network Listeners, then catch up on anything missed while booting
    this.setupNetworkHandlers();
    this.socket.emit('game:sync', {}, (res) => {
      if (res && res.room && this.player.active) this.applySnapshot(res.room);
    });

    // 13. Initialize Real-Time Facility Minimap Radar
    this.initMinimap();

    // 14. Announce Rule Banner
    this.showRuleBanner(
      window.CONSTANTS.RULES.COBB_MOVE,
      'Cobb can move. Find the coal, feed the furnace, and escape.'
    );

    // 15. Initial HUD Update
    this.updateHUD();
  }

  buildDungeon() {
    const ts = window.CONSTANTS.TILE_SIZE;
    for (let y = 0; y < this.mapData.height; y++) {
      for (let x = 0; x < this.mapData.width; x++) {
        const tile = this.mapData.grid[y][x];
        const px = x * ts + ts / 2;
        const py = y * ts + ts / 2;

        if (tile === 1) {
          this.add.image(px, py, 'tile_floor');
        } else if (tile === 2) {
          const wall = this.wallsGroup.create(px, py, 'tile_wall');
          wall.refreshBody();
        }
      }
    }
  }

  createFurnace() {
    const f = this.mapData.furnace;
    this.furnaceSprite = this.add.image(f.x, f.y, 'furnace_sprite');
    this.physics.add.existing(this.furnaceSprite, true);
  }

  createExitDoor() {
    const e = this.mapData.exit;
    this.exitDoorSprite = this.add.image(e.x, e.y, 'exit_door');
    this.physics.add.existing(this.exitDoorSprite, true);
  }

  createInteractiveObjects() {
    this.coalGroup = this.physics.add.staticGroup();
    this.coalMap = new Map();

    this.mapData.coal.forEach(c => this.placeCoal(c));

    this.breakerGroup = this.physics.add.staticGroup();
    if (this.mapData.breakers) {
      this.mapData.breakers.forEach(b => {
        const sprite = this.breakerGroup.create(b.x, b.y, 'breaker_sprite');
        sprite.breakerId = b.id;
      });
    }
  }

  createPlayer() {
    this.player = this.physics.add.sprite(this.me.x, this.me.y, 'player_sprite');
    this.player.setTint(this.me.color);
    this.player.setCollideWorldBounds(true);
    this.player.body.setSize(18, 18);
    this.player.body.setOffset(7, 7);
    this.player.setDepth(10); // Render above floor and items

    this.player.stamina = window.CONSTANTS.PLAYER.MAX_STAMINA;
    this.player.hasCoal = false;
    this.player.isSprinting = false;

    // Collide with Walls & Furnace
    this.physics.add.collider(this.player, this.wallsGroup);
    this.physics.add.collider(this.player, this.furnaceSprite);
  }

  addCobb(c) {
    const sprite = this.add.sprite(c.x, c.y, 'cobb_sprite');
    sprite.setDepth(11); // Render on top
    sprite.setFlipX(c.flipX);
    sprite.targetX = c.x;
    sprite.targetY = c.y;
    this.cobbs.set(c.id, sprite);
    return sprite;
  }

  // Tighter smoothing than for players: a Cobb drawn behind its real position makes grabs look unfair
  updateCobbs(delta) {
    const t = Math.min(1, delta / 40);
    this.cobbs.forEach((sprite) => {
      sprite.x += (sprite.targetX - sprite.x) * t;
      sprite.y += (sprite.targetY - sprite.y) * t;
    });
  }

  // 9. Crisp Horror Darkness & Fog-of-War System
  createDarknessLayer(worldW, worldH) {
    // Subtle warm lantern halo around player
    this.lanternGlow = this.add.circle(this.player.x, this.player.y, 85, 0xffaa22, 0.12);
    this.lanternGlow.setDepth(5);

    // Warm fire halo around furnace
    const f = this.mapData.furnace;
    this.furnaceGlow = this.add.circle(f.x, f.y, 110, 0xff5511, 0.18);
    this.furnaceGlow.setDepth(5);

    this.tweens.add({
      targets: this.furnaceGlow,
      scaleX: 1.15,
      scaleY: 1.15,
      alpha: 0.25,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Subtle hallway beacon lights at room doorways
    const doorways = [
      { x: 22.5 * 32, y: 10.5 * 32 }, // North door
      { x: 22.5 * 32, y: 25.5 * 32 }, // South door
      { x: 15.5 * 32, y: 18.5 * 32 }, // West door
      { x: 30.5 * 32, y: 18.5 * 32 }  // East door
    ];

    doorways.forEach(d => {
      const beacon = this.add.circle(d.x, d.y, 45, 0xffaa33, 0.08);
      beacon.setDepth(4);
    });

    // Exit blast door beacon (red locked / green unlocked)
    const e = this.mapData.exit;
    this.exitBeacon = this.add.circle(e.x, e.y, 55, 0xff3344, 0.15);
    this.exitBeacon.setDepth(4);
  }

  updateDarkness() {
    if (this.lanternGlow && this.player) {
      this.lanternGlow.setPosition(this.player.x, this.player.y);
      // Subtle lantern flicker
      this.lanternGlow.alpha = 0.10 + Math.sin(this.time.now / 150) * 0.04;
    }
  }

  update(time, delta) {
    if (!this.player || !this.player.body) return;

    const active = this.status === 'active';
    this.handleMapToggle();
    if (active) {
      this.updateReviving();
      this.handlePlayerMovement(delta);
      this.handleInteractions();
    } else {
      this.player.setVelocity(0, 0);
    }
    this.updateRemotePlayers(delta);
    this.updateCobbs(delta);
    this.updateDarkness();
    this.updateMinimap(delta);

    // Network Sync (20 ticks/sec)
    this.networkSendTimer -= delta;
    if (active && this.networkSendTimer <= 0) {
      this.networkSendTimer = 50;
      this.socket.emit('player:move', {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        flipX: this.player.flipX,
        isSprinting: this.player.isSprinting
      });
    }
  }

  addRemotePlayer(p) {
    const remote = this.add.sprite(p.x, p.y, 'player_sprite');
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

      let text = remote.name;
      if (remote.state === 'dead') {
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
    this.setReviving(!!this.reviveTarget && (this.wasd.interact.isDown || this.wasd.space.isDown));
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
      this.lanternGlow.setVisible(false);
      this.showRuleBanner('YOU ESCAPED', 'Waiting for the others to get out...');
      this.spectate();
    }
    this.updateHUD();
  }

  handleMapToggle() {
    if (!Phaser.Input.Keyboard.JustDown(this.wasd.map)) return;
    const minimapBox = document.getElementById('minimap-box');
    const btnToggle = document.getElementById('btn-toggle-map');
    minimapBox.classList.toggle('expanded');
    btnToggle.textContent = minimapBox.classList.contains('expanded') ? '[M] CLOSE' : '[M] FULL';
  }

  handlePlayerMovement(delta) {
    const dt = delta / 1000;
    let moveX = 0;
    let moveY = 0;

    if (this.cursors.left.isDown || this.wasd.left.isDown) moveX -= 1;
    if (this.cursors.right.isDown || this.wasd.right.isDown) moveX += 1;
    if (this.cursors.up.isDown || this.wasd.up.isDown) moveY -= 1;
    if (this.cursors.down.isDown || this.wasd.down.isDown) moveY += 1;

    // Flip sprite facing direction
    if (moveX < 0) this.player.setFlipX(true);
    else if (moveX > 0) this.player.setFlipX(false);

    // Sprinting check
    const wantsSprint = this.wasd.shift.isDown && (moveX !== 0 || moveY !== 0);

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
    const velocity = new Phaser.Math.Vector2(moveX, moveY).normalize().scale(currentSpeed);
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
                                Phaser.Input.Keyboard.JustDown(this.wasd.space);

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

    // 3. Exit Escape
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
      coalElem.textContent = `${this.mapData.furnace.coalDeposited} / ${this.mapData.furnace.coalRequired}`;
    }
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
  }

  setupNetworkHandlers() {
    const handlers = {
      'player:moved': (data) => {
        const remote = this.remotePlayers.get(data.id);
        if (!remote) return;
        remote.targetX = data.x;
        remote.targetY = data.y;
        remote.setFlipX(data.flipX);
      },

      // Server rejected a move (too fast or out of bounds)
      'player:correct': (data) => {
        this.player.setPosition(data.x, data.y);
      },

      'player:left': (data) => {
        this.removeRemotePlayer(data.id);
      },

      'player:escaped': (data) => this.applyPlayerState(data.id, 'escaped'),
      'player:downed': (data) => this.applyPlayerState(data.id, 'downed'),
      'player:revived': (data) => this.applyPlayerState(data.id, 'active'),
      'player:died': (data) => this.applyPlayerState(data.id, 'dead'),

      // Coal a downed or departed player was carrying, back on the floor
      'coal:dropped': (data) => {
        this.placeCoal({ id: data.coalId, x: data.x, y: data.y, collected: false });
        if (data.droppedBy === this.myId) this.player.hasCoal = false;
        this.updateHUD();
      },

      'world:tick': (data) => {
        data.cobbs.forEach((c) => {
          const sprite = this.cobbs.get(c.id) || this.addCobb(c);
          sprite.targetX = c.x;
          sprite.targetY = c.y;
          sprite.setFlipX(c.flipX);
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
          this.player.hasCoal = true;
          this.cameras.main.flash(150, 255, 170, 34);
          this.updateHUD();
        }
      },

      'furnace:updated': (data) => {
        this.mapData.furnace.coalDeposited = data.coalDeposited;
        this.mapData.exit.unlocked = data.exitUnlocked;
        if (this.exitBeacon && data.exitUnlocked) this.exitBeacon.fillColor = 0x38ef7d;
        if (data.depositedBy === this.myId) {
          this.player.hasCoal = false;
          if (data.exitUnlocked) {
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
      sprite = this.coalGroup.create(c.x, c.y, 'coal_sprite');
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
    if (this.mapData.exit.unlocked) this.exitBeacon.fillColor = 0x38ef7d;

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
    const scale = 4; // 4px per tile (46 * 4 = 184, 36 * 4 = 144)

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);

    // 1. Draw floor rooms & corridors
    for (let y = 0; y < this.mapData.height; y++) {
      for (let x = 0; x < this.mapData.width; x++) {
        if (this.mapData.grid[y][x] === 1) {
          ctx.fillStyle = '#1c2130';
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // 2. Draw Exit Blast Door
    const ex = Math.floor(this.mapData.exit.x / 32) * scale;
    const ey = Math.floor(this.mapData.exit.y / 32) * scale;
    ctx.fillStyle = this.mapData.exit.unlocked ? '#38ef7d' : '#ff3344';
    ctx.fillRect(ex - 2, ey - 2, scale + 4, scale + 4);

    // 3. Draw Furnace
    const fx = Math.floor(this.mapData.furnace.x / 32) * scale;
    const fy = Math.floor(this.mapData.furnace.y / 32) * scale;
    ctx.fillStyle = '#ff6600';
    ctx.fillRect(fx - 2, fy - 2, scale + 4, scale + 4);

    // 4. Draw Coal Chunks
    ctx.fillStyle = '#ffaa22';
    this.coalMap.forEach((sprite) => {
      if (sprite.active) {
        const cx = Math.floor(sprite.x / 32) * scale;
        const cy = Math.floor(sprite.y / 32) * scale;
        ctx.fillRect(cx + 1, cy + 1, scale - 2, scale - 2);
      }
    });

    // 5. Draw Breakers
    ctx.fillStyle = '#00d2ff';
    if (this.mapData.breakers) {
      this.mapData.breakers.forEach((b) => {
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

    // 7. Draw Remote Players in their own colours
    this.remotePlayers.forEach((remote) => {
      if (remote.active) {
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
