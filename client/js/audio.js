// Procedural sound: everything is synthesized with the Web Audio API, so there are no audio
// files to load or license. Browsers only allow audio after a click or key press, so call
// Sound.unlock() from input handlers; it is safe to call often.
window.Sound = (() => {
  let ctx = null;
  let master = null;
  let noise = null;
  let muted = false;
  try {
    muted = localStorage.getItem('cobbMuted') === '1';
  } catch (e) { /* storage blocked: default to sound on */ }

  const loops = {};

  function unlock() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.6;
      master.connect(ctx.destination);
      // One second of white noise, reused by every noisy sound
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      startLoops();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  const ready = () => ctx && ctx.state === 'running';

  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('cobbMuted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.6, ctx.currentTime, 0.05);
    return muted;
  }

  // A filtered noise hit: footsteps, clicks, thuds
  function burst({ freq = 800, q = 1, dur = 0.08, gain = 0.3, type = 'bandpass', delay = 0 }) {
    if (!ready() || gain <= 0.001) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(amp).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // A pitched note with a fast attack and decay; `to` slides the pitch
  function tone({ freq, to = freq, dur = 0.2, gain = 0.2, type = 'sine', delay = 0 }) {
    if (!ready() || gain <= 0.001) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // Continuous beds whose volume the game sets every frame: the fire, and Cobb breathing
  function startLoops() {
    const bed = (freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = freq;
      filter.Q.value = q;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      src.connect(filter).connect(amp).connect(master);
      src.start();
      return amp;
    };
    loops.fire = bed(320, 0.7);
    loops.breath = bed(500, 4);

    // A low, slightly detuned drone under everything; it swells as Cobb gets close
    const drone = ctx.createGain();
    drone.gain.value = 0;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 260;
    lowpass.connect(drone).connect(master);
    [55, 58.3, 82.4].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(lowpass);
      osc.start();
    });
    loops.drone = drone;
  }

  function setLoop(name, level, breathing = false, max = 0.35) {
    if (!ready() || !loops[name]) return;
    let v = Math.max(0, Math.min(1, level));
    // Breathing swells in and out rather than hissing steadily
    if (breathing) v *= 0.5 + 0.5 * Math.sin(ctx.currentTime * 2.2);
    loops[name].gain.setTargetAtTime(v * max, ctx.currentTime, 0.1);
  }

  // A shriek: a rising saw over a band of hiss
  function screech(gain, dur) {
    tone({ freq: 700, to: 2600, dur, gain, type: 'sawtooth' });
    tone({ freq: 740, to: 2300, dur, gain: gain * 0.7, type: 'square' });
    burst({ freq: 3200, q: 2, dur, gain });
  }

  return {
    unlock,
    toggleMute,
    isMuted: () => muted,
    setFire: level => setLoop('fire', level),
    setBreath: level => setLoop('breath', level, true),
    // Always a faint unease; louder when Cobb is near
    setDrone: (level, idle = 0.15) => setLoop('drone', idle + (1 - idle) * level, false, 0.22),
    // Cobb's footfalls: slow, heavy, getting louder
    cobbStep: level => burst({ freq: 110, q: 1, dur: 0.18, gain: 0.6 * level, type: 'lowpass' }),
    // Cobb has seen you
    chaseSting: () => screech(0.22, 0.5),
    // The grab: a scream right in your ears
    jumpscare: () => {
      screech(0.5, 0.9);
      burst({ freq: 150, q: 0.5, dur: 0.9, gain: 0.8, type: 'lowpass' });
    },
    // The building settling somewhere far away (or is it?)
    creak: (level = 0.4) => {
      tone({ freq: 190, to: 140, dur: 1.4, gain: 0.05 * level, type: 'sawtooth' });
      burst({ freq: 900, q: 8, dur: 1.2, gain: 0.08 * level });
    },
    flicker: (level = 1) => burst({ freq: 4000, q: 12, dur: 0.05, gain: 0.08 * level }),
    footstep: (sprint, level = 1) => burst({ freq: sprint ? 900 : 600, q: 1.5, dur: 0.06, gain: 0.12 * level }),
    heartbeat: (level) => {
      tone({ freq: 60, to: 40, dur: 0.12, gain: 0.5 * level });
      tone({ freq: 55, to: 38, dur: 0.12, gain: 0.35 * level, delay: 0.18 });
    },
    coal: () => burst({ freq: 2500, q: 6, dur: 0.12, gain: 0.25 }),
    deposit: () => {
      burst({ freq: 200, q: 0.8, dur: 0.5, gain: 0.4, type: 'lowpass' });
      tone({ freq: 140, to: 90, dur: 0.4, gain: 0.15, type: 'triangle' });
    },
    breaker: (level = 1) => {
      burst({ freq: 1200, q: 2, dur: 0.05, gain: 0.4 * level });
      tone({ freq: 80, dur: 0.25, gain: 0.25 * level, type: 'square' });
    },
    rockThrow: () => burst({ freq: 1500, q: 0.7, dur: 0.15, gain: 0.15, type: 'highpass' }),
    rockLand: (level = 1) => burst({ freq: 400, q: 1, dur: 0.12, gain: 0.45 * level }),
    stun: () => tone({ freq: 1200, to: 300, dur: 0.35, gain: 0.2, type: 'sawtooth' }),
    grab: () => {
      tone({ freq: 220, to: 55, dur: 0.6, gain: 0.5, type: 'sawtooth' });
      burst({ freq: 300, q: 0.5, dur: 0.4, gain: 0.5, type: 'lowpass' });
    },
    revive: () => [523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.25, gain: 0.15, delay: i * 0.08 })),
    escape: () => [392, 523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.4, gain: 0.15, delay: i * 0.12 })),
    death: () => tone({ freq: 300, to: 40, dur: 1.2, gain: 0.3, type: 'triangle' })
  };
})();
