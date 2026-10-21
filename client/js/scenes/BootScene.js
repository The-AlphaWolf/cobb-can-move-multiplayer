class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    this.createFloorTexture();
    this.createWallTexture();
    this.createPlayerTexture();
    this.createCobbTexture();
    this.createCobbEyesTexture();
    this.createCoalTexture();
    this.createFurnaceTexture();
    this.createBreakerTexture();
    this.createExitDoorTexture();
    this.createRockTexture();
    this.createCarrotTexture();
    this.createParticleTexture();
    this.createLampTexture();
    this.createTilesetTexture();
  }

  // Tilemap tileset: index matches the map grid value (0 empty, 1 floor, 2 wall)
  createTilesetTexture() {
    const canvas = this.textures.createCanvas('tileset', 96, 32);
    const ctx = canvas.context;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 32, 32);
    ctx.drawImage(this.textures.get('tile_floor').getSourceImage(), 32, 0);
    ctx.drawImage(this.textures.get('tile_wall').getSourceImage(), 64, 0);
    canvas.refresh();
  }

  // Ceiling lamp (14x14), lit by breakers
  createLampTexture() {
    const canvas = this.textures.createCanvas('lamp_sprite', 14, 14);
    const ctx = canvas.context;
    ctx.fillStyle = '#3a3f4d';
    ctx.fillRect(5, 0, 4, 3);
    ctx.fillStyle = '#c9c2a3';
    ctx.beginPath();
    ctx.arc(7, 8, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff6d0';
    ctx.fillRect(5, 6, 3, 3);
    canvas.refresh();
  }

  create() {
    console.log('[BootScene] Crisp retro pixel art textures generated.');
    this.scene.start('GameScene', { room: this.registry.get('room') });
  }

  // Dungeon Paved Stone Floor (32x32) - Clean, readable, textured
  createFloorTexture() {
    const canvas = this.textures.createCanvas('tile_floor', 32, 32);
    const ctx = canvas.context;
    // Base stone color
    ctx.fillStyle = '#2a2d36';
    ctx.fillRect(0, 0, 32, 32);

    // Stone tile seams
    ctx.strokeStyle = '#1a1c22';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, 32, 32);
    ctx.strokeRect(0, 0, 16, 16);
    ctx.strokeRect(16, 16, 16, 16);

    // Subtle stone texture flecks
    ctx.fillStyle = '#373b47';
    ctx.fillRect(3, 3, 2, 2);
    ctx.fillRect(11, 8, 2, 2);
    ctx.fillRect(19, 22, 2, 2);
    ctx.fillRect(27, 27, 2, 2);

    ctx.fillStyle = '#1e2027';
    ctx.fillRect(7, 12, 3, 2);
    ctx.fillRect(22, 5, 2, 2);
    canvas.refresh();
  }

  // Dungeon Stone Wall with 3D Top Bevel (32x32) - Clearly separated from floor
  createWallTexture() {
    const canvas = this.textures.createCanvas('tile_wall', 32, 32);
    const ctx = canvas.context;
    // Deep dark wall base
    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, 0, 32, 32);

    // Stone brick rows
    ctx.fillStyle = '#1e212b';
    ctx.fillRect(1, 1, 30, 9);
    ctx.fillRect(1, 11, 14, 9);
    ctx.fillRect(17, 11, 14, 9);
    ctx.fillRect(1, 21, 30, 10);

    // 3D Top Highlight (makes walls clearly pop out as solid obstacles!)
    ctx.fillStyle = '#454a5c';
    ctx.fillRect(0, 0, 32, 3);
    ctx.fillStyle = '#5c637a';
    ctx.fillRect(0, 0, 32, 1);

    // Mortar lines
    ctx.fillStyle = '#08090d';
    ctx.fillRect(0, 10, 32, 1);
    ctx.fillRect(0, 20, 32, 1);
    ctx.fillRect(15, 10, 2, 10);

    // Bottom shadow cast onto floor
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 29, 32, 3);
    canvas.refresh();
  }

  // The Warden Player Character (32x32) - Clear silhouette, cap, blue coat, lantern
  createPlayerTexture() {
    const canvas = this.textures.createCanvas('player_sprite', 32, 32);
    const ctx = canvas.context;

    // Shadow underneath player
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(16, 28, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Blue Trench Coat / Body
    ctx.fillStyle = '#223c5e';
    ctx.fillRect(10, 12, 12, 14);
    ctx.fillStyle = '#172a42';
    ctx.fillRect(12, 14, 8, 12);

    // Head / Face
    ctx.fillStyle = '#f0c89e';
    ctx.fillRect(11, 5, 10, 8);

    // Warden Cap (Dark navy with golden visor trim)
    ctx.fillStyle = '#101e30';
    ctx.fillRect(9, 2, 14, 5);
    ctx.fillStyle = '#ffaa22';
    ctx.fillRect(9, 6, 14, 2);

    // Eyes
    ctx.fillStyle = '#0f141d';
    ctx.fillRect(13, 8, 2, 2);
    ctx.fillRect(18, 8, 2, 2);

    // Hand holding Brass Lantern
    ctx.fillStyle = '#f0c89e';
    ctx.fillRect(23, 16, 3, 3);

    // Lantern Frame & Glowing Wick
    ctx.fillStyle = '#3a2d18';
    ctx.fillRect(22, 17, 7, 9);
    ctx.fillStyle = '#ffcc44';
    ctx.fillRect(24, 19, 4, 5);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(25, 20, 2, 3);
    canvas.refresh();
  }

  // Cobb (32x40): a hunched, starved red thing. Arms too long, hanging past its feet, a head
  // that sits crooked, and a grin full of teeth. Its eyes are a separate texture so they can
  // glow in the dark (see createCobbEyesTexture).
  createCobbTexture() {
    const canvas = this.textures.createCanvas('cobb_sprite', 32, 40);
    const ctx = canvas.context;
    const px = (color, x, y, w = 1, h = 1) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };

    // Shadow pooling under it
    ctx.fillStyle = 'rgba(10, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.ellipse(16, 37, 12, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Spindly legs, knees bent the wrong way
    px('#3d0808', 12, 28, 2, 6);
    px('#3d0808', 18, 28, 2, 6);
    px('#3d0808', 11, 34, 2, 3);
    px('#3d0808', 19, 34, 2, 3);

    // Hunched, starved torso with ribs showing
    px('#5c0c0c', 11, 14, 10, 15);
    px('#7a1212', 12, 13, 8, 3);
    px('#2a0404', 13, 17, 6, 1);
    px('#2a0404', 13, 20, 6, 1);
    px('#2a0404', 13, 23, 6, 1);
    px('#2a0404', 15, 17, 2, 9);

    // Arms hang far past the knees and end in long claws
    px('#4a0a0a', 7, 13, 3, 4);
    px('#4a0a0a', 6, 16, 2, 16);
    px('#4a0a0a', 22, 13, 3, 4);
    px('#4a0a0a', 24, 16, 2, 16);
    px('#d8d0c0', 4, 32, 1, 5);
    px('#d8d0c0', 6, 33, 1, 5);
    px('#d8d0c0', 8, 32, 1, 4);
    px('#d8d0c0', 24, 32, 1, 4);
    px('#d8d0c0', 26, 33, 1, 5);
    px('#d8d0c0', 28, 32, 1, 5);

    // Long head tilted to one side
    px('#8a1515', 9, 1, 13, 12);
    px('#a51c1c', 10, 2, 11, 3);
    px('#5c0c0c', 9, 10, 2, 3);

    // Hollow sockets (the glow comes from the eyes texture)
    px('#000000', 11, 4, 4, 4);
    px('#000000', 17, 3, 4, 4);

    // A grin too wide for the face, full of teeth
    px('#120000', 10, 9, 12, 3);
    for (let x = 10; x < 22; x += 2) {
      px('#e8e0cc', x, 9, 1, 1);
      px('#e8e0cc', x + 1, 11, 1, 1);
    }
    canvas.refresh();
  }

  // Cobb's eyes on their own (same 32x40 frame): drawn without lighting, so in the dark
  // all you see is two pale points moving toward you
  createCobbEyesTexture() {
    const canvas = this.textures.createCanvas('cobb_eyes', 32, 40);
    const ctx = canvas.context;
    // A red bloom around each eye, then a white-hot core
    ctx.fillStyle = 'rgba(255, 40, 30, 0.22)';
    ctx.fillRect(9, 2, 8, 8);
    ctx.fillRect(15, 1, 8, 8);
    ctx.fillStyle = 'rgba(255, 70, 50, 0.5)';
    ctx.fillRect(11, 4, 4, 4);
    ctx.fillRect(17, 3, 4, 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(12, 5, 2, 2);
    ctx.fillRect(18, 4, 2, 2);
    canvas.refresh();
  }

  // Heavy Industrial Iron Furnace (48x48) with Glowing Grate & Smoke
  createFurnaceTexture() {
    const canvas = this.textures.createCanvas('furnace_sprite', 48, 48);
    const ctx = canvas.context;

    // Cast Iron Body
    ctx.fillStyle = '#1e2129';
    ctx.fillRect(4, 6, 40, 38);
    ctx.strokeStyle = '#383e4d';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 6, 40, 38);

    // Smokestack on top
    ctx.fillStyle = '#15171d';
    ctx.fillRect(18, 0, 12, 7);
    ctx.strokeStyle = '#383e4d';
    ctx.strokeRect(18, 0, 12, 7);

    // Rivets
    ctx.fillStyle = '#525a6e';
    ctx.fillRect(6, 8, 3, 3);
    ctx.fillRect(39, 8, 3, 3);
    ctx.fillRect(6, 40, 3, 3);
    ctx.fillRect(39, 40, 3, 3);

    // Glowing Firebox Grate
    ctx.fillStyle = '#cc2200';
    ctx.fillRect(12, 20, 24, 18);
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(15, 23, 18, 12);
    ctx.fillStyle = '#ffea55';
    ctx.fillRect(18, 26, 12, 6);

    // Heavy Iron Bars over fire
    ctx.fillStyle = '#111317';
    ctx.fillRect(17, 20, 2, 18);
    ctx.fillRect(23, 20, 2, 18);
    ctx.fillRect(29, 20, 2, 18);
    canvas.refresh();
  }

  // Sparkling Coal Chunk (20x20)
  createCoalTexture() {
    const canvas = this.textures.createCanvas('coal_sprite', 20, 20);
    const ctx = canvas.context;
    // Coal Body
    ctx.fillStyle = '#15161a';
    ctx.beginPath();
    ctx.moveTo(10, 2);
    ctx.lineTo(18, 6);
    ctx.lineTo(17, 16);
    ctx.lineTo(8, 18);
    ctx.lineTo(2, 11);
    ctx.closePath();
    ctx.fill();

    // Dark grey crystalline facets
    ctx.fillStyle = '#2b2d36';
    ctx.fillRect(6, 6, 7, 7);

    // Bright Mineral Glint
    ctx.fillStyle = '#7a8296';
    ctx.fillRect(7, 4, 4, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(8, 5, 2, 2);
    canvas.refresh();
  }

  // Blast Exit Door (32x32) with Red/Green Indicator Lights
  createExitDoorTexture() {
    const canvas = this.textures.createCanvas('exit_door', 32, 32);
    const ctx = canvas.context;

    // Steel door plate
    ctx.fillStyle = '#222836';
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = '#3c455c';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 32, 32);

    // Hazard Stripes
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(2, 4, 28, 4);
    ctx.fillRect(2, 24, 28, 4);
    ctx.fillStyle = '#111';
    for (let i = 2; i < 30; i += 6) {
      ctx.fillRect(i, 4, 3, 4);
      ctx.fillRect(i, 24, 3, 4);
    }

    // Heavy Valve Wheel
    ctx.fillStyle = '#4c556b';
    ctx.beginPath();
    ctx.arc(16, 16, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#141822';
    ctx.beginPath();
    ctx.arc(16, 16, 3, 0, Math.PI * 2);
    ctx.fill();

    // Red Lock Light (top center)
    ctx.fillStyle = '#ff3344';
    ctx.beginPath();
    ctx.arc(16, 11, 2, 0, Math.PI * 2);
    ctx.fill();
    canvas.refresh();
  }

  // Wall-Mounted Breaker Box (20x28)
  createBreakerTexture() {
    const canvas = this.textures.createCanvas('breaker_sprite', 20, 28);
    const ctx = canvas.context;
    ctx.fillStyle = '#282d38';
    ctx.fillRect(2, 2, 16, 24);
    ctx.strokeStyle = '#4b5366';
    ctx.lineWidth = 1;
    ctx.strokeRect(2, 2, 16, 24);

    // Red light (alarm/breaker active indicator)
    ctx.fillStyle = '#ff3344';
    ctx.fillRect(6, 5, 8, 5);

    // Heavy Switch handle
    ctx.fillStyle = '#e6eaed';
    ctx.fillRect(8, 14, 4, 8);
    canvas.refresh();
  }

  // Throwable Rock (16x16)
  createRockTexture() {
    const canvas = this.textures.createCanvas('rock_sprite', 16, 16);
    const ctx = canvas.context;
    ctx.fillStyle = '#4e5566';
    ctx.beginPath();
    ctx.arc(8, 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a859e';
    ctx.fillRect(5, 4, 5, 4);
    canvas.refresh();
  }

  // Carrot (18x18)
  createCarrotTexture() {
    const canvas = this.textures.createCanvas('carrot_sprite', 18, 18);
    const ctx = canvas.context;
    ctx.fillStyle = '#ff7b00';
    ctx.fillRect(6, 5, 6, 9);
    ctx.fillRect(7, 14, 4, 3);
    ctx.fillStyle = '#38ef7d';
    ctx.fillRect(5, 1, 8, 4);
    canvas.refresh();
  }

  // Particle Texture
  createParticleTexture() {
    const canvas = this.textures.createCanvas('particle_ember', 6, 6);
    const ctx = canvas.context;
    ctx.fillStyle = '#ffaa22';
    ctx.fillRect(1, 1, 4, 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(2, 2, 2, 2);
    canvas.refresh();
  }
}

window.BootScene = BootScene;
