class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.roomData = data ? data.room : null;
    this.isOnline = !!this.roomData;
    this.socket = window.gameSocket || null;
  }

  create() {
    console.log('[GameScene] Initializing atmospheric horror dungeon...');

    // 1. Generate or load procedural map
    if (this.roomData && this.roomData.mapData) {
      this.mapData = this.roomData.mapData;
    } else {
      // In Solo mode, generate using the universal MapGenerator
      const generator = new window.MapGenerator(Date.now());
      this.mapData = generator.generate(46, 36, { playerCount: 1 });
    }

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

    // 7. Spawn Cobb Monster
    this.createCobb();

    // 8. Remote Players Container for Multiplayer
    this.remotePlayers = new Map();

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
    this.keyM = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);

    // 12. Setup Network Listeners if Online
    if (this.isOnline && this.socket) {
      this.setupNetworkHandlers();
    }

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

    this.mapData.coal.forEach(c => {
      if (!c.collected) {
        const sprite = this.coalGroup.create(c.x, c.y, 'coal_sprite');
        sprite.coalId = c.id;
        this.coalMap.set(c.id, sprite);
      }
    });

    this.breakerGroup = this.physics.add.staticGroup();
    if (this.mapData.breakers) {
      this.mapData.breakers.forEach(b => {
        const sprite = this.breakerGroup.create(b.x, b.y, 'breaker_sprite');
        sprite.breakerId = b.id;
      });
    }
  }

  createPlayer() {
    const spawn = (this.mapData.playerSpawns && this.mapData.playerSpawns[0]) || { x: 300, y: 300 };
    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player_sprite');
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

  createCobb() {
    const spawn = this.mapData.cobbSpawn || { x: 300, y: 200 };
    this.cobb = this.physics.add.sprite(spawn.x, spawn.y, 'cobb_sprite');
    this.cobb.setCollideWorldBounds(true);
    this.cobb.body.setSize(18, 22);
    this.cobb.body.setOffset(7, 9);
    this.cobb.setDepth(11); // Render on top

    this.cobbSpeed = 55; // Gentle, slow, creepy patrol
    // Start target in distant outer room (Room 1 or 5), FAR from furnace!
    const outerRoom = (this.mapData.rooms && this.mapData.rooms[1]) || { centerX: 8, centerY: 7 };
    this.cobbTargetPos = { x: outerRoom.centerX * 32 + 16, y: outerRoom.centerY * 32 + 16 };
    this.cobbWaypointTimer = 8000; // Stay in outer rooms for at least 8 seconds!
    this.cobbState = 'WANDER';
    this.cobbChaseTimer = 0;
    this.cobbStunTimer = 0;
    this.cobbPauseTimer = 0;
    this.playerInvincibleTimer = 0;
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

    this.handlePlayerMovement(delta);
    this.handleInteractions();
    this.updateCobbAI(delta);
    this.updateDarkness();
    this.updateMinimap(delta);

    // Network Sync (20 ticks/sec)
    if (this.isOnline && this.socket && this.networkSendTimer <= 0) {
      this.networkSendTimer = 50;
      this.socket.emit('player:move', {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        vx: Math.round(this.player.body.velocity.x),
        vy: Math.round(this.player.body.velocity.y),
        isSprinting: this.player.isSprinting,
        hasCoal: this.player.hasCoal
      });
    } else if (this.networkSendTimer > 0) {
      this.networkSendTimer -= delta;
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
    // Toggle Facility Minimap Radar
    if (Phaser.Input.Keyboard.JustDown(this.wasd.map) || Phaser.Input.Keyboard.JustDown(this.keyM)) {
      const minimapBox = document.getElementById('minimap-box');
      const btnToggle = document.getElementById('btn-toggle-map');
      if (minimapBox) {
        minimapBox.classList.toggle('expanded');
        if (btnToggle) {
          btnToggle.textContent = minimapBox.classList.contains('expanded') ? '[M] CLOSE' : '[M] FULL';
        }
      }
    }

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
          this.pickupCoal(id, sprite);
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

  pickupCoal(coalId, sprite) {
    this.player.hasCoal = true;
    sprite.destroy();
    this.coalMap.delete(coalId);

    if (this.isOnline && this.socket) {
      this.socket.emit('coal:pickup', { coalId });
    }

    this.cameras.main.flash(150, 255, 170, 34);
    this.updateHUD();
    console.log(`[Game] Picked up coal: ${coalId}`);
  }

  depositCoal() {
    this.player.hasCoal = false;
    this.mapData.furnace.coalDeposited += 1;

    const isUnlocked = this.mapData.furnace.coalDeposited >= this.mapData.furnace.coalRequired;
    if (isUnlocked) {
      this.mapData.exit.unlocked = true;
      if (this.exitBeacon) this.exitBeacon.fillColor = 0x38ef7d;
      this.cameras.main.flash(500, 56, 239, 125);
    } else {
      this.cameras.main.flash(200, 255, 100, 0);
    }

    if (this.isOnline && this.socket) {
      this.socket.emit('furnace:deposit');
    }

    this.updateHUD();
    console.log(`[Game] Deposited coal! Total: ${this.mapData.furnace.coalDeposited}`);
  }

  escape() {
    console.log('[Game] Player escaped!');
    if (this.isOnline && this.socket) {
      this.socket.emit('player:escape');
    }
    alert('🎉 YOU ESCAPED FROM COBB! Level Complete.');
  }

  updateCobbAI(delta) {
    if (!this.cobb || !this.cobb.body) return;

    // 1. Cobb Hit-Stun State (after attacking or when stunned)
    if (this.cobbStunTimer > 0) {
      this.cobbStunTimer -= delta;
      this.cobb.setVelocity(0, 0);
      this.cobb.setAlpha(0.6 + Math.sin(this.time.now / 100) * 0.4); // Stun flicker
      return;
    } else {
      this.cobb.setAlpha(1.0);
    }

    // 2. Cobb Confused / Search Pause (after losing a chase)
    if (this.cobbPauseTimer > 0) {
      this.cobbPauseTimer -= delta;
      this.cobb.setVelocity(0, 0);
      return;
    }

    // Player Invincibility timer countdown & visual flash
    if (this.playerInvincibleTimer > 0) {
      this.playerInvincibleTimer -= delta;
      this.player.setAlpha(Math.sin(this.time.now / 80) > 0 ? 0.4 : 1.0);
    } else {
      this.player.setAlpha(1.0);
    }

    const distToPlayer = Phaser.Math.Distance.Between(this.cobb.x, this.cobb.y, this.player.x, this.player.y);

    // 3. Aggro Detection:
    // On Level 1 ("Cobb can move"), Cobb is slow and mostly unalert.
    // He only starts chasing if you literally bump into his direct proximity (< 60px).
    if (distToPlayer < 65 && this.cobbState !== 'CHASE') {
      this.cobbState = 'CHASE';
      this.cobbChaseTimer = 2500; // 2.5s chase max!
      this.cameras.main.shake(100, 0.01);
    }

    // 4. Chase Behavior
    if (this.cobbState === 'CHASE') {
      this.cobbChaseTimer -= delta;
      this.cobbTargetPos = { x: this.player.x, y: this.player.y };
      this.cobbSpeed = 85; // 85 px/s (Very easy to outrun! Player walk is 145, sprint is 230!)

      // If player walks/sprints away (> 130px) or 2.5s expires, Cobb loses interest and pauses!
      if (this.cobbChaseTimer <= 0 || distToPlayer > 130) {
        this.cobbState = 'WANDER';
        this.cobbPauseTimer = 2500; // Cobb stops and looks around confused for 2.5s!
        // Pick an outer room to wander away to
        const outerRoom = (this.mapData.rooms && this.mapData.rooms[1]) || { centerX: 5, centerY: 5 };
        this.cobbTargetPos = { x: outerRoom.centerX * 32 + 16, y: outerRoom.centerY * 32 + 16 };
        this.cobbWaypointTimer = 6000;
      }
    } else {
      // 5. Normal Wandering Behavior (Slow, creepy patrol through outer corridors)
      this.cobbSpeed = 50; // Slow 50 px/s
      this.cobbWaypointTimer -= delta;
      const distToTarget = Phaser.Math.Distance.Between(this.cobb.x, this.cobb.y, this.cobbTargetPos.x, this.cobbTargetPos.y);

      if (this.cobbWaypointTimer <= 0 || distToTarget < 35) {
        this.cobbWaypointTimer = Phaser.Math.Between(5000, 9000);
        // Avoid always targeting the furnace room
        const candidateRooms = this.mapData.rooms.filter(r => r.id !== 0);
        const targetRoom = Phaser.Utils.Array.GetRandom(candidateRooms.length ? candidateRooms : this.mapData.rooms);
        this.cobbTargetPos = {
          x: targetRoom.centerX * 32 + 16,
          y: targetRoom.centerY * 32 + 16
        };
      }
    }

    // Move smoothly towards current waypoint / target
    const angle = Phaser.Math.Angle.Between(this.cobb.x, this.cobb.y, this.cobbTargetPos.x, this.cobbTargetPos.y);
    const vx = Math.cos(angle) * this.cobbSpeed;
    const vy = Math.sin(angle) * this.cobbSpeed;

    this.cobb.setVelocity(vx, vy);

    if (vx < -5) this.cobb.setFlipX(true);
    else if (vx > 5) this.cobb.setFlipX(false);

    // 6. Collision / Attack Check
    if (distToPlayer < 24 && this.playerInvincibleTimer <= 0) {
      this.cameras.main.shake(180, 0.025);

      // Cobb is STUNNED after attacking for 3.5 seconds so player easily escapes!
      this.cobbStunTimer = 3500;
      this.cobbState = 'WANDER';
      this.playerInvincibleTimer = 4000; // 4 seconds grace period!

      // Cobb turns around and decides to walk to another room
      const safeRoom = (this.mapData.rooms && this.mapData.rooms[3]) || { centerX: 10, centerY: 25 };
      this.cobbTargetPos = { x: safeRoom.centerX * 32 + 16, y: safeRoom.centerY * 32 + 16 };
      this.cobbWaypointTimer = 8000;

      // Knock player back safely away from Cobb
      const pushAngle = Phaser.Math.Angle.Between(this.cobb.x, this.cobb.y, this.player.x, this.player.y);
      this.player.x += Math.cos(pushAngle) * 55;
      this.player.y += Math.sin(pushAngle) * 55;

      // Adrenaline burst for player: instant full stamina refill!
      this.player.stamina = window.CONSTANTS.PLAYER.MAX_STAMINA;
    }
  }

  showRuleBanner(ruleName, subtitle) {
    const banner = document.getElementById('rule-banner');
    const titleText = document.getElementById('banner-rule-text');
    const subText = document.getElementById('banner-rule-sub');
    if (!banner || !titleText) return;

    titleText.textContent = ruleName;
    subText.textContent = subtitle || '';
    banner.classList.remove('hidden');

    setTimeout(() => {
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
    this.socket.on('player:moved', (data) => {
      let remote = this.remotePlayers.get(data.id);
      if (!remote) {
        remote = this.physics.add.sprite(data.x, data.y, 'player_sprite');
        remote.setDepth(10);
        this.remotePlayers.set(data.id, remote);
      }
      remote.setPosition(data.x, data.y);
    });

    this.socket.on('player:left', (data) => {
      const remote = this.remotePlayers.get(data.id);
      if (remote) {
        remote.destroy();
        this.remotePlayers.delete(data.id);
      }
    });

    this.socket.on('coal:updated', (data) => {
      const sprite = this.coalMap.get(data.coalId);
      if (sprite) {
        sprite.destroy();
        this.coalMap.delete(data.coalId);
      }
    });

    this.socket.on('furnace:updated', (data) => {
      this.mapData.furnace.coalDeposited = data.coalDeposited;
      this.mapData.exit.unlocked = data.exitUnlocked;
      if (this.exitBeacon && data.exitUnlocked) this.exitBeacon.fillColor = 0x38ef7d;
      this.updateHUD();
    });
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

    // 7. Draw Remote Players in Multiplayer
    this.remotePlayers.forEach((remote) => {
      if (remote.active) {
        const rx = (remote.x / 32) * scale;
        const ry = (remote.y / 32) * scale;
        ctx.fillStyle = '#ff63b1';
        ctx.beginPath();
        ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
}

window.GameScene = GameScene;
